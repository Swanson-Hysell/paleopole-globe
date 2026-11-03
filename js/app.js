/* PaleopoleGlobe: a lightweight, GPlates-style reconstruction app for teaching
 * how paleomagnetic poles constrain paleogeography.
 *
 * The current data set is the "Pole to Pangea" scenario of ESCI 2201 Lab 9
 * (DATA.meta.title); plate IDs, pairs and lab-part set-ups below are still
 * specific to it.
 *
 * Data (window.LAB9_DATA) are written by 2026_build/scripts/make_webdata.py.
 * Geometry helpers live in geomath.js (window.GeoMath).
 *
 * Interaction (no tool modes): drag a continent to move it, drag a focus-age
 * pole to move its continent by that pole (it snaps onto the North Pole), drag
 * the ocean to turn the globe.
 */
(function () {
  'use strict';

  const G = window.GeoMath;
  const DATA = window.LAB9_DATA;
  const { cart, sph, qMul, qConj, qMatrix, mApply, qRotate, qEuler, qBetween, qToEuler, QI } = G;

  // ---------------------------------------------------------------------------
  // configuration
  // ---------------------------------------------------------------------------
  const AGE_MAX = 320;
  const ALIGN_TOL = 1.0;            // deg: "pole is on the north pole"
  const SNAP = 2.0;                 // deg: a dragged pole snaps onto the north pole
  const NP = [0, 0, 1];
  const PAIRS = { 'AFR-NAM': ['AFR', 'NAM'], 'SAM-AFR': ['SAM', 'AFR'], 'EUR-NAM': ['EUR', 'NAM'] };
  const SHAPES = { NAM: 'circle', EUR: 'square', SAM: 'triangle', AFR: 'diamond' };
  const VIRIDIS = ['#440154', '#482475', '#414487', '#355f8d', '#2a788e', '#21918c',
                   '#22a884', '#44bf70', '#7ad151', '#bddf26', '#fde725'];
  const ageColor = d3.scaleLinear()
    .domain(d3.range(VIRIDIS.length).map(i => AGE_MAX * (1 - i / (VIRIDIS.length - 1))))
    .range(VIRIDIS).interpolate(d3.interpolateRgb).clamp(true);   // old = purple, young = yellow
  const PARAMS = new URLSearchParams(location.search);
  const INSTRUCTOR = PARAMS.has('instructor');

  // lab-part set-ups: which plates and poles are shown, and what is compared
  const PARTS = {
    B: { show: ['NAM', 'GRN', 'AFR'], poles: ['NAM', 'AFR'], pair: 'AFR-NAM', select: 'NAM', age: 250 },
    C: { show: ['SAM', 'AFR'], poles: ['SAM', 'AFR'], pair: 'SAM-AFR', select: 'SAM', age: 250 },
    all: { show: null, poles: null, pair: null, select: null, age: null },
  };

  // ---------------------------------------------------------------------------
  // plates
  // ---------------------------------------------------------------------------
  const plates = DATA.plates.map(p => Object.assign({}, p));
  const byId = Object.fromEntries(plates.map(p => [p.id, p]));
  const topPlates = plates.filter(p => !p.parent);

  function ringsToVectors(polys) {
    return polys.map(poly => poly.map(ring => ring.map(([lon, lat]) => cart(lat, lon))));
  }
  function geoFromLonLat(polys) {
    return { type: 'MultiPolygon', coordinates: polys };
  }
  plates.forEach(p => {
    p.landV = ringsToVectors(p.land);
    p.shelfV = ringsToVectors(p.shelf);
    p.landGeo = geoFromLonLat(p.land);
    p.shelfGeo = geoFromLonLat(p.shelf);
    // d3-geo wants clockwise exterior rings; guard against reversed winding
    ['land', 'shelf'].forEach(kind => {
      if (d3.geoArea(p[kind + 'Geo']) > 2 * Math.PI) {
        console.warn('reversing winding of', p.id, kind);
        p[kind].forEach(poly => poly.forEach(r => r.reverse()));
        p[kind + 'V'] = ringsToVectors(p[kind]);
      }
    });
    // exterior rings only: the selection outline should not trace lakes and other holes
    p.landOuterV = p.landV.map(poly => [poly[0]]);
    p.shelfOuterV = p.shelfV.map(poly => [poly[0]]);
    p.centroidV = cart(p.centroid[0], p.centroid[1]);
    p.predriftQ = p.predrift ? qEuler(p.predrift.lat, p.predrift.lon, p.predrift.angle) : null;
    p.children = plates.filter(c => c.parent === p.id).map(c => c.id);
    p.dark = d3.color(p.color).darker(1.1).formatHex();
    p.light = d3.interpolateRgb(p.color, '#ffffff')(0.45);
    p.shelfFill = d3.interpolateRgb(p.color, '#f4efe6')(0.35);
  });

  const poleSets = {};
  Object.entries(DATA.poles).forEach(([k, arr]) => {
    poleSets[k] = arr.map(d => Object.assign({}, d, { v: cart(d.lat, d.lon) }));
  });
  const paleopoles = {};
  Object.entries(DATA.paleopoles).forEach(([k, arr]) => {
    paleopoles[k] = arr.map(d => Object.assign({}, d, { v: cart(d.lat, d.lon) }));
  });
  const sites = DATA.sites.map(s => Object.assign({}, s, {
    v: cart(s.lat, s.lon), vN: cart(Math.min(s.lat + 0.5, 89.9), s.lon),
  }));

  // ---------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------
  const state = {
    q: Object.fromEntries(topPlates.map(p => [p.id, QI.slice()])),
    closed: { GRN: false, IBE: false },  // sub-plates in their pre-drift position
    selected: 'NAM',
    part: 'B',
    visible: Object.fromEntries(plates.map(p => [p.id, true])),
    poleVisible: { NAM: true, EUR: false, SAM: false, AFR: true },
    age: 250, ageMin: 0, ageMax: AGE_MAX,
    opts: { paths: true, circles: true, allAges: false, paleopoles: false,
            graticule: true, ghost: false, shelf: true, labels: true, sites: true },
    pair: 'AFR-NAM',
    view: { rotate: [100, -68, 0], zoom: 1 },   // looking down on North America and the 250 Ma poles
  };
  let movedOnce = false;     // hide the "how to drag" hint once a plate has been moved

  function effectiveQ(id) {
    const p = byId[id];
    if (!p.parent) return state.q[id];
    const rel = state.closed[id] && p.predriftQ ? p.predriftQ : QI;
    return qMul(state.q[p.parent], rel);
  }
  function topOf(id) { return byId[id].parent || id; }

  function applyPart(part, quiet) {
    const P = PARTS[part];
    if (!P) return;
    state.part = part;
    plates.forEach(p => { state.visible[p.id] = !P.show || P.show.includes(p.id); });
    Object.keys(state.poleVisible).forEach(k => { state.poleVisible[k] = !P.poles || P.poles.includes(k); });
    if (P.pair) state.pair = P.pair;
    if (P.select) state.selected = P.select;
    if (P.age != null) state.age = P.age;
    if (!quiet) { syncControls(); changed(); }
  }

  // ---------------------------------------------------------------------------
  // undo / redo
  // ---------------------------------------------------------------------------
  const undoStack = [], redoStack = [];
  function snapshotModel() {
    return JSON.stringify({ q: state.q, closed: state.closed });
  }
  function restoreModel(s) {
    const o = JSON.parse(s);
    state.q = o.q; state.closed = o.closed;
    syncControls();
  }
  function pushHistory() {
    undoStack.push(snapshotModel());
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotModel());
    restoreModel(undoStack.pop());
    changed();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotModel());
    restoreModel(redoStack.pop());
    changed();
  }
  function updateUndoButtons() {
    $('#btn-undo').disabled = !undoStack.length;
    $('#btn-redo').disabled = !redoStack.length;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function fmtLat(lat) { return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`; }
  function fmtLon(lon) {
    lon = ((lon + 540) % 360) - 180;
    return `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  }
  function fmtEuler(e) {
    return `axis ${fmtLat(e.lat)}, ${fmtLon(e.lon)}; angle ${e.angle >= 0 ? '+' : '−'}${Math.abs(e.angle).toFixed(1)}°`;
  }
  /* How the site's continent has turned between its current position and today.
     az is the azimuth (clockwise from north) of the site's present-day north arrow
     in the current position: if that arrow points 24° clockwise of north, the
     continent has since turned 24° counterclockwise to reach today's orientation. */
  function sinceText(az, short) {
    const cw = az <= 180 ? az : az - 360;
    if (Math.abs(cw) < 0.5) return 'none';
    const dir = cw > 0 ? (short ? 'CCW' : 'counterclockwise') : (short ? 'CW' : 'clockwise');
    return `${Math.abs(cw).toFixed(0)}° ${dir}`;
  }
  function ageRanges(ages) {
    const out = [];
    ages.forEach(a => {
      const last = out[out.length - 1];
      if (last && a - last[1] === 10) last[1] = a; else out.push([a, a]);
    });
    return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function safeStorage(op, key, val) {
    try {
      if (op === 'get') return window.localStorage.getItem(key);
      window.localStorage.setItem(key, val);
    } catch (e) { /* storage blocked: fine */ }
    return null;
  }

  // ---------------------------------------------------------------------------
  // canvas & projection
  // ---------------------------------------------------------------------------
  const stage = $('#stage');
  const canvas = $('#globe');
  const ctx = canvas.getContext('2d');
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.4);
  let W = 0, H = 0, DPR = 1, baseScale = 1;

  function resize() {
    const r = stage.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    baseScale = Math.min(W, H) / 2 * 0.9;
    applyView();
    draw();
  }
  function applyView() {
    projection.translate([W / 2, H / 2]).scale(baseScale * state.view.zoom).rotate(state.view.rotate);
  }
  function viewCenterV() {
    const r = projection.rotate();
    return cart(-r[1], -r[0]);
  }

  // rotated geometry --------------------------------------------------------
  function rotatedMulti(polysV, q) {
    const m = qMatrix(q);
    return {
      type: 'MultiPolygon',
      coordinates: polysV.map(poly => poly.map(ring => ring.map(v => {
        const [lat, lon] = sph(mApply(m, v));
        return [lon, lat];
      }))),
    };
  }
  function ll(v) { const [lat, lon] = sph(v); return [lon, lat]; }

  // markers -----------------------------------------------------------------
  function markerPath(c, shape, x, y, r) {
    c.beginPath();
    if (shape === 'circle') c.arc(x, y, r, 0, 2 * Math.PI);
    else if (shape === 'square') c.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
    else if (shape === 'triangle') {
      c.moveTo(x, y - r * 1.15); c.lineTo(x + r * 1.05, y + r * 0.75); c.lineTo(x - r * 1.05, y + r * 0.75); c.closePath();
    } else if (shape === 'diamond') {
      c.moveTo(x, y - r * 1.2); c.lineTo(x + r, y); c.lineTo(x, y + r * 1.2); c.lineTo(x - r, y); c.closePath();
    } else if (shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
        c[i ? 'lineTo' : 'moveTo'](x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      c.closePath();
    }
  }

  // hit targets rebuilt every frame
  let hitPoles = [];

  // ---------------------------------------------------------------------------
  // drawing
  // ---------------------------------------------------------------------------
  let needsDraw = false;
  function changed() {
    if (!needsDraw) {
      needsDraw = true;
      requestAnimationFrame(() => { needsDraw = false; draw(); updatePanels(); });
    }
  }

  function draw(c = ctx, scaleFactor = DPR) {
    c.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);
    c.clearRect(0, 0, W, H);
    if (c !== ctx) {          // exported image: paint the background too
      c.fillStyle = '#0c1622'; c.fillRect(0, 0, W, H);
    }
    const p = d3.geoPath(projection, c);
    const centerV = viewCenterV();
    const visibleV = v => G.dot(v, centerV) > 0.02;
    hitPoles = [];

    // ocean (a medium blue, so that both the darkest and the lightest age colors stand out)
    const [cx, cy] = projection.translate(), R = projection.scale();
    const grad = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    grad.addColorStop(0, '#6aa3cc'); grad.addColorStop(0.75, '#447ca9'); grad.addColorStop(1, '#326690');
    c.beginPath(); p({ type: 'Sphere' }); c.fillStyle = grad; c.fill();

    // graticule
    if (state.opts.graticule) {
      c.beginPath(); p(d3.geoGraticule().step([10, 10])());
      c.strokeStyle = 'rgba(255,255,255,0.15)'; c.lineWidth = 0.7; c.stroke();
      c.beginPath(); p(d3.geoGraticule().step([30, 30])());
      c.strokeStyle = 'rgba(255,255,255,0.24)'; c.lineWidth = 0.8; c.stroke();
      c.beginPath(); p({ type: 'LineString', coordinates: [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0]] });
      c.strokeStyle = 'rgba(255,255,255,0.42)'; c.lineWidth = 1.1; c.stroke();
    }

    // present-day ghost outlines
    if (state.opts.ghost) {
      c.save(); c.setLineDash([4, 3]);
      plates.forEach(pl => {
        if (!state.visible[pl.id]) return;
        c.beginPath(); p(pl.landGeo);
        c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 0.8; c.stroke();
      });
      c.restore();
    }

    // plates
    // South America is drawn last (on top), so that where rigid North America (Mexico) and
    // South America overlap in a Pangea fit, South America's outline stays visible
    const drawOrder = ['AFR', 'EUR', 'IBE', 'NAM', 'GRN', 'SAM'];
    const geoms = {};
    drawOrder.forEach(id => {
      if (!state.visible[id]) return;
      const q = effectiveQ(id), pl = byId[id];
      geoms[id] = { land: rotatedMulti(pl.landV, q), shelf: state.opts.shelf ? rotatedMulti(pl.shelfV, q) : null };
    });
    if (state.opts.shelf) {
      drawOrder.forEach(id => {
        if (!geoms[id]) return;
        c.beginPath(); p(geoms[id].shelf);
        c.fillStyle = byId[id].shelfFill; c.globalAlpha = 0.78; c.fill(); c.globalAlpha = 1;
      });
    }
    // land, each plate with its selection outline in its own layer, so that a plate drawn
    // later (on top) also covers the outline of the selected plate where they overlap
    const sel = state.selected;
    const selIds = [sel].concat(byId[sel].children);
    const outline = id => {
      const pl = byId[id];
      c.beginPath(); p(rotatedMulti(state.opts.shelf ? pl.shelfOuterV : pl.landOuterV, effectiveQ(id)));
      c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 1.8; c.stroke();
    };
    drawOrder.forEach(id => {
      if (!geoms[id]) return;
      const pl = byId[id];
      if (selIds.includes(id) && state.opts.shelf) outline(id);
      c.beginPath(); p(geoms[id].land);
      c.fillStyle = pl.color; c.fill();
      c.strokeStyle = pl.dark; c.lineWidth = 0.6; c.stroke();
      if (selIds.includes(id) && !state.opts.shelf) outline(id);
    });

    // reference sites
    if (state.opts.sites) {
      sites.forEach(s => {
        if (!state.visible[s.plate]) return;
        const v = qRotate(effectiveQ(s.plate), s.v);
        if (!visibleV(v)) return;
        const [x, y] = projection(ll(v));
        markerPath(c, 'star', x, y, 6.5);
        c.fillStyle = '#ffffff'; c.fill(); c.strokeStyle = '#1b2733'; c.lineWidth = 1; c.stroke();
        haloText(c, s.name, x + 8, y + 4, 11, '#ffffff', 'left', 500);
        hitPoles.push({ x, y, r: 8, kind: 'site', site: s, v });
      });
    }

    // focus-age poles: where are they? (used to keep labels apart)
    const focusNow = [];
    topPlates.forEach(pl => {
      const k = pl.poleSet;
      if (!k || !state.poleVisible[k] || !state.visible[pl.id]) return;
      const f = focusPole(k);
      if (f && visibleV(f.rv)) focusNow.push(f);
    });
    const poleNearNP = focusNow.some(f => f.dist < 4);

    // geographic poles: target crosshair
    drawTarget(c, p, visibleV, poleNearNP);

    // paleomagnetic poles
    const focusLabels = [];
    topPlates.forEach(pl => {
      const k = pl.poleSet;
      if (!k || !state.poleVisible[k] || !state.visible[pl.id]) return;
      const q = state.q[pl.id], m = qMatrix(q);
      const inRange = poleSets[k].filter(d => d.age >= state.ageMin && d.age <= state.ageMax);
      const rot = inRange.map(d => Object.assign({}, d, { rv: mApply(m, d.v) }));
      // individual paleopoles (behind the reference path)
      if (state.opts.paleopoles) drawPaleopoles(c, p, k, m, visibleV);
      // APW path
      if (state.opts.paths && rot.length > 1) {
        const line = { type: 'LineString', coordinates: rot.map(d => ll(d.rv)) };
        c.beginPath(); p(line); c.strokeStyle = 'rgba(10,20,30,0.65)'; c.lineWidth = 3.6; c.stroke();
        c.beginPath(); p(line); c.strokeStyle = pl.light; c.lineWidth = 1.8; c.stroke();
      }
      // confidence circle of the focus-age pole
      const focus = rot.find(d => d.age === state.age);
      if (focus && state.opts.circles) {
        c.beginPath(); p(d3.geoCircle().center(ll(focus.rv)).radius(Math.max(focus.p95, 0.3))());
        const col = d3.color(ageColor(focus.age));
        col.opacity = 0.28; c.fillStyle = col.formatRgb(); c.fill();
        c.strokeStyle = '#ffffff'; c.lineWidth = 1.2; c.stroke();
      }
      // small markers first, the focus pole last (on top)
      rot.slice().sort((a, b) => (a.age === state.age) - (b.age === state.age)).forEach(d => {
        const isFocus = d.age === state.age;
        if (!isFocus && !state.opts.allAges && !state.opts.paths) return;
        if (!visibleV(d.rv)) return;
        const [x, y] = projection(ll(d.rv));
        const r = isFocus ? 8 : (state.opts.allAges ? 5 : 3.2);
        markerPath(c, SHAPES[k], x, y, r);
        c.fillStyle = ageColor(d.age); c.fill();
        c.strokeStyle = '#ffffff';
        c.lineWidth = isFocus ? 2.2 : 1.3; c.stroke();
        if (isFocus) focusLabels.push({ x, y, name: pl.name });
        hitPoles.push({ x, y, r: isFocus ? 12 : Math.max(r, 6), kind: 'pole', plate: pl, pole: d, isFocus });
      });
    });
    // focus-pole labels, drawn last; poles that sit on top of each other share one label
    const groups = [];
    focusLabels.forEach(l => {
      const g = groups.find(gr => Math.hypot(gr.x - l.x, gr.y - l.y) < 14);
      if (g) g.names.push(l.name); else groups.push({ x: l.x, y: l.y, names: [l.name] });
    });
    groups.forEach(g => {
      haloText(c, `${g.names.join(' + ')} ${state.age} Ma`, g.x + 13, g.y - 1, 11.5, '#fff4d6', 'left', 650);
    });

    // plate labels
    if (state.opts.labels) {
      topPlates.forEach(pl => {
        if (!state.visible[pl.id]) return;
        const v = qRotate(state.q[pl.id], pl.centroidV);
        if (!visibleV(v)) return;
        const [x, y] = projection(ll(v));
        // step the label below a site star that sits near the plate's center
        const near = hitPoles.some(h => h.kind === 'site' && Math.abs(h.x + 25 - x) < 50 && Math.abs(h.y - y) < 12);
        haloText(c, pl.name, x, near ? y + 18 : y, 13, '#ffffff', 'center', 700);
      });
    }

    // limb
    c.beginPath(); p({ type: 'Sphere' });
    c.strokeStyle = 'rgba(160,200,235,0.55)'; c.lineWidth = 1.2; c.stroke();
  }

  function drawTarget(c, p, visibleV, poleNearNP) {
    if (visibleV(NP)) {
      c.beginPath(); p(d3.geoCircle().center([0, 90]).radius(SNAP)());
      c.fillStyle = 'rgba(255,255,255,0.18)'; c.fill();
      c.beginPath(); p(d3.geoCircle().center([0, 90]).radius(5)());
      c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 1; c.stroke(); c.restore();
      const [x, y] = projection([0, 90]);
      c.beginPath(); c.moveTo(x - 10, y); c.lineTo(x + 10, y); c.moveTo(x, y - 10); c.lineTo(x, y + 10);
      c.strokeStyle = '#ffffff'; c.lineWidth = 1.6; c.stroke();
      // the label moves out of the way when a pole label sits next to the crosshair
      if (poleNearNP) haloText(c, 'North Pole', x - 14, y + 14, 11, '#ffffff', 'right', 600);
      else haloText(c, 'North Pole', x - 12, y - 10, 11, '#ffffff', 'right', 600);
    }
    if (visibleV([0, 0, -1])) {
      const [x, y] = projection([0, -90]);
      c.beginPath(); c.moveTo(x - 6, y); c.lineTo(x + 6, y); c.moveTo(x, y - 6); c.lineTo(x, y + 6);
      c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 1.2; c.stroke();
      haloText(c, 'South Pole', x + 8, y - 6, 10.5, 'rgba(255,255,255,0.8)', 'left', 500);
    }
  }

  function drawPaleopoles(c, p, k, m, visibleV) {
    const win = state.opts.allAges ? [state.ageMin, state.ageMax] : [state.age - 10, state.age + 10];
    paleopoles[k].forEach(d => {
      if (d.age < win[0] || d.age > win[1]) return;
      const rv = mApply(m, d.v);
      if (!visibleV(rv)) return;
      if (d.a95) {
        c.beginPath(); p(d3.geoCircle().center(ll(rv)).radius(d.a95)());
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 0.7; c.stroke();
      }
      const [x, y] = projection(ll(rv));
      markerPath(c, SHAPES[k], x, y, 3.4);
      c.fillStyle = 'rgba(12,22,34,0.55)'; c.fill();
      c.strokeStyle = ageColor(d.age); c.lineWidth = 1.6; c.stroke();
      hitPoles.push({ x, y, r: 5, kind: 'paleopole', set: k, pole: d, rv });
    });
  }

  function haloText(c, text, x, y, size, color, align, weight) {
    c.font = `${weight || 600} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    c.textAlign = align || 'left'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = 3.2; c.strokeStyle = 'rgba(8,16,26,0.85)';
    c.strokeText(text, x, y); c.fillStyle = color; c.fillText(text, x, y);
  }

  // ---------------------------------------------------------------------------
  // derived quantities for readouts
  // ---------------------------------------------------------------------------
  function focusPole(k) {
    const d = poleSets[k].find(x => x.age === state.age);
    if (!d) return null;
    const plate = topPlates.find(p => p.poleSet === k);
    const rv = qRotate(state.q[plate.id], d.v);
    return { d, rv, dist: G.angle(rv, NP), plate };
  }
  function siteNow(s) {
    const q = effectiveQ(s.plate);
    const v = qRotate(q, s.v), vN = qRotate(q, s.vN);
    // azimuth of the site's present-day north arrow in the current frame
    const az = G.azimuth(v, vN);
    return { v, lat: sph(v)[0], az };
  }
  function relativeEuler(moving, fixed) {
    return qToEuler(qMul(qConj(state.q[fixed]), state.q[moving]));
  }
  function pairDistances(pair) {
    const [a, b] = PAIRS[pair];
    const qa = state.q[a], qb = state.q[b];
    return poleSets[a].map((pa, i) => {
      const pb = poleSets[b][i];
      return {
        age: pa.age, p95: pa.p95 + pb.p95,
        dist: G.angle(qRotate(qa, pa.v), qRotate(qb, pb.v)),
      };
    }).filter(d => d.age >= state.ageMin && d.age <= state.ageMax);
  }

  // ---------------------------------------------------------------------------
  // side panel
  // ---------------------------------------------------------------------------
  function buildPlateList() {
    const box = $('#plate-list');
    box.innerHTML = '';
    plates.forEach(pl => {
      const row = document.createElement('div');
      row.className = 'plate-row' + (pl.parent ? ' child' : '');
      row.dataset.id = pl.id;
      if (!pl.parent) {
        const r = document.createElement('input');
        r.type = 'radio'; r.name = 'plate'; r.value = pl.id; r.id = 'sel-' + pl.id;
        r.setAttribute('aria-label', 'Select ' + pl.name);
        r.addEventListener('change', () => select(pl.id));
        row.appendChild(r);
      }
      const sw = document.createElement('span');
      sw.className = 'swatch'; sw.style.background = pl.color;
      row.appendChild(sw);
      const nm = document.createElement('label');
      nm.className = 'name'; nm.textContent = pl.parent ? `${pl.name} (moves with ${byId[pl.parent].name})` : pl.name;
      if (!pl.parent) nm.htmlFor = 'sel-' + pl.id;
      row.appendChild(nm);
      if (!pl.parent) {
        const show = document.createElement('label');
        show.className = 'show';
        show.innerHTML = '<input type="checkbox"> show';
        show.title = 'Show or hide ' + pl.name;
        show.querySelector('input').addEventListener('change', e => {
          state.visible[pl.id] = e.target.checked;
          pl.children.forEach(cid => { state.visible[cid] = e.target.checked; });
          state.poleVisible[pl.poleSet] = e.target.checked;
          syncControls(); changed();
        });
        row.appendChild(show);
      }
      box.appendChild(row);
    });

    const tg = $('#pole-toggles');
    tg.innerHTML = '';
    topPlates.forEach(pl => {
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="checkbox" data-poles="${pl.poleSet}"> ${shapeSvg(SHAPES[pl.poleSet], pl.color)} ${pl.name}`;
      lab.querySelector('input').addEventListener('change', e => {
        state.poleVisible[pl.poleSet] = e.target.checked; changed();
      });
      tg.appendChild(lab);
    });
  }

  function buildLegendShapes() {
    const ls = $('#legend-shapes');
    ls.innerHTML = topPlates.filter(pl => state.visible[pl.id] && state.poleVisible[pl.poleSet])
      .map(pl => `<span>${shapeSvg(SHAPES[pl.poleSet], '#dbe6f0')}${pl.name}</span>`).join('') +
      `<span>${starSvg()}site</span>`;
  }

  function shapeSvg(shape, fill) {
    const s = {
      circle: '<circle cx="7" cy="7" r="5"/>',
      square: '<rect x="2.5" y="2.5" width="9" height="9"/>',
      triangle: '<path d="M7 1.5L12.5 11.5H1.5Z"/>',
      diamond: '<path d="M7 1L12 7L7 13L2 7Z"/>',
    }[shape];
    return `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" style="fill:${fill};stroke:#1b2733;stroke-width:1">${s}</svg>`;
  }
  function starSvg() {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 2.7 : 6;
      d += (i ? 'L' : 'M') + (7 + r * Math.cos(a)).toFixed(2) + ' ' + (7 + r * Math.sin(a)).toFixed(2);
    }
    return `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" style="fill:#fff;stroke:#1b2733"><path d="${d}Z"/></svg>`;
  }

  function syncControls() {
    plates.forEach(pl => {
      const row = document.querySelector(`.plate-row[data-id="${pl.id}"]`);
      if (!row) return;
      row.classList.toggle('selected', pl.id === state.selected);
      row.classList.toggle('hidden-plate', !state.visible[pl.id]);
      const r = row.querySelector('input[type=radio]');
      if (r) r.checked = pl.id === state.selected;
      const show = row.querySelector('.show input');
      if (show) show.checked = !!state.visible[pl.id];
    });
    document.querySelectorAll('.setup-btn').forEach(b => {
      const on = b.dataset.part === state.part;
      b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on));
    });
    document.querySelectorAll('[data-poles]').forEach(el => { el.checked = !!state.poleVisible[el.dataset.poles]; });
    $('#opt-close').checked = !!(state.closed.GRN && state.closed.IBE);
    $('#opt-close').indeterminate = state.closed.GRN !== state.closed.IBE;
    $('#age').value = state.age; $('#age-out').textContent = `${state.age} Ma`;
    $('#age-min').value = state.ageMin; $('#age-max').value = state.ageMax;
    const o = state.opts;
    $('#opt-paths').checked = o.paths; $('#opt-circles').checked = o.circles;
    $('#opt-allages').checked = o.allAges; $('#opt-paleopoles').checked = o.paleopoles;
    $('#opt-graticule').checked = o.graticule; $('#opt-ghost').checked = o.ghost;
    $('#opt-shelf').checked = o.shelf; $('#opt-labels').checked = o.labels; $('#opt-sites').checked = o.sites;
    $('#pair').value = state.pair;
    $('#move-plate-name').textContent = byId[state.selected].name;
    buildLegendShapes();
    updateUndoButtons();
  }

  function updatePanels() {
    // Euler rotation of the selected plate (skip fields being edited)
    const e = qToEuler(state.q[state.selected]);
    const fields = { '#eu-lat': e.lat, '#eu-lon': e.lon, '#eu-ang': e.angle };
    Object.entries(fields).forEach(([sel, val]) => {
      const el = $(sel);
      if (document.activeElement !== el) el.value = (Math.abs(val) < 0.005 ? 0 : val).toFixed(2);
    });

    // focus-age poles
    let html = `<tr><th>${state.age} Ma pole</th><th>Lat</th><th>Lon</th>` +
      `<th title="Angular distance from the geographic North Pole">From N pole</th>` +
      `<th title="Radius of the pole's 95% confidence circle">95% circle</th></tr>`;
    topPlates.forEach(pl => {
      if (!state.poleVisible[pl.poleSet] || !state.visible[pl.id]) return;
      const f = focusPole(pl.poleSet);
      if (!f) return;
      const [lat, lon] = sph(f.rv);
      const ok = f.dist <= ALIGN_TOL;
      html += `<tr class="${ok ? 'ok' : ''}"><td>${shapeSvg(SHAPES[pl.poleSet], ageColor(state.age))} ${pl.name}</td>` +
        `<td class="num">${fmtLat(lat)}</td><td class="num">${fmtLon(lon)}</td>` +
        `<td class="num dist">${f.dist.toFixed(1)}°${ok ? '<span class="badge-ok">on pole</span>' : ''}</td>` +
        `<td class="num">${f.d.p95.toFixed(1)}°</td></tr>`;
    });
    $('#readout-poles').innerHTML = html;

    // sites
    let sh = '<tr><th>Site</th><th title="Latitude on the globe in its current position">Latitude now</th>' +
      '<th title="How the continent has turned between the position shown and today">Turned since then</th></tr>';
    sites.forEach(s => {
      if (!state.visible[s.plate]) return;
      const n = siteNow(s);
      sh += `<tr><td>${starSvg()} ${s.name}</td><td class="num">${fmtLat(n.lat)}</td>` +
        `<td class="num">${sinceText(n.az)}</td></tr>`;
    });
    $('#readout-sites').innerHTML = sh;

    // relative rotations, for pairs that are on screen
    const rows = [['AFR', 'NAM', 'Africa relative to North America'], ['SAM', 'AFR', 'South America relative to Africa'],
                  ['EUR', 'NAM', 'Europe relative to North America']]
      .filter(([a, b]) => state.visible[a] && state.visible[b])
      .map(([a, b, label]) => {
        const r = relativeEuler(a, b);
        return `<div>${label}:<br><code>${r.angle === 0 ? 'none (present-day positions)' : fmtEuler(r)}</code></div>`;
      });
    $('#readout-rel').innerHTML = rows.length
      ? rows.join('') + '<p class="hint">One continent’s position relative to another, as an angle about a rotation axis through Earth’s center (an Euler pole). + is counterclockwise.</p>'
      : '';

    drawChart();
    updateHud();
  }

  function updateHud() {
    const lines = [];
    if (!movedOnce) lines.push('<span class="hud-hint">Drag a continent (or its large pole marker) to move it · drag the ocean to turn the globe</span>');
    const f = focusPole(byId[state.selected].poleSet);
    if (f && state.poleVisible[f.plate.poleSet] && state.visible[state.selected]) {
      lines.push(f.dist <= ALIGN_TOL
        ? `<b>${f.plate.name}</b>’s ${state.age} Ma pole is <b class="ok">on the North Pole</b>.`
        : `<b>${f.plate.name}</b>’s ${state.age} Ma pole is ${f.dist.toFixed(1)}° from the North Pole.`);
      sites.filter(s => topOf(s.plate) === state.selected && state.visible[s.plate]).forEach(s => {
        const n = siteNow(s);
        lines.push(`${s.name}: ${fmtLat(n.lat)} · turned since then: ${sinceText(n.az, true)}`);
      });
    }
    $('#hud-status').innerHTML = lines.join('<br>');
  }

  // path-match chart ----------------------------------------------------------
  function drawChart() {
    const box = $('#match-chart');
    const data = pairDistances(state.pair);
    const w = 340, h = 170, m = { l: 34, r: 10, t: 10, b: 30 };
    const yMax = Math.max(10, Math.ceil((d3.max(data, d => Math.max(d.dist, d.p95)) || 10) / 5) * 5);
    const x = d3.scaleLinear().domain([0, AGE_MAX]).range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain([0, yMax]).range([h - m.b, m.t]);
    let svg = d3.select(box).select('svg');
    if (svg.empty()) {
      svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('role', 'img');
      svg.append('g').attr('class', 'grid');
      svg.append('path').attr('class', 'band');
      svg.append('path').attr('class', 'line');
      svg.append('g').attr('class', 'dots');
      svg.append('g').attr('class', 'axis x').attr('transform', `translate(0,${h - m.b})`);
      svg.append('g').attr('class', 'axis y').attr('transform', `translate(${m.l},0)`);
      svg.append('text').attr('class', 'xlabel').attr('x', (w + m.l) / 2).attr('y', h - 2)
        .attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', '#4a5866').text('Pole age (Ma)');
      svg.append('text').attr('class', 'ylabel').attr('transform', `translate(10,${(h - m.b + m.t) / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', '#4a5866').text('Pole separation (°)');
      svg.append('line').attr('class', 'focus');
    }
    const [a, b] = PAIRS[state.pair];
    svg.attr('aria-label', `Angular distance between same-age poles of ${byId[a].name} and ${byId[b].name}`);
    svg.select('.grid').selectAll('line').data(y.ticks(5)).join('line')
      .attr('x1', m.l).attr('x2', w - m.r).attr('y1', d => y(d)).attr('y2', d => y(d));
    svg.select('.band').datum(data)
      .attr('d', d3.area().x(d => x(d.age)).y0(y(0)).y1(d => y(d.p95)).curve(d3.curveStepAfter))
      .attr('fill', '#dfe6ed');
    svg.select('.line').datum(data)
      .attr('d', d3.line().x(d => x(d.age)).y(d => y(d.dist)))
      .attr('fill', 'none').attr('stroke', '#9aa6b2').attr('stroke-width', 1.1);
    const ok = d => d.dist <= d.p95;
    svg.select('.dots').selectAll('circle').data(data, d => d.age).join('circle')
      .attr('cx', d => x(d.age)).attr('cy', d => y(d.dist)).attr('r', d => d.age === state.age ? 5 : 3.6)
      .attr('fill', d => ok(d) ? ageColor(d.age) : '#ffffff')
      .attr('stroke', d => ok(d) ? '#1b2733' : ageColor(d.age))
      .attr('stroke-width', d => ok(d) ? (d.age === state.age ? 1.6 : 0.8) : 1.8)
      .selectAll('title').data(d => [d]).join('title')
      .text(d => `${d.age} Ma: poles ${d.dist.toFixed(1)}° apart (95% circles overlap if less than ${d.p95.toFixed(1)}°)`);
    svg.select('.focus').attr('x1', x(state.age)).attr('x2', x(state.age)).attr('y1', m.t).attr('y2', h - m.b)
      .attr('stroke', '#f2b134').attr('stroke-dasharray', '3 3');
    svg.select('.axis.x').call(d3.axisBottom(x).tickValues([0, 40, 80, 120, 160, 200, 240, 280, 320]).tickSizeOuter(0));
    svg.select('.axis.y').call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));

    const over = data.filter(ok).map(d => d.age);
    $('#match-summary').innerHTML =
      `Each dot is the distance between the ${byId[a].name} and ${byId[b].name} poles of the same age; ` +
      `the grey band is how close they must be for their 95% circles to overlap. ` +
      `<b>${over.length} of ${data.length}</b> ages overlap now` +
      (over.length ? `: <b>${ageRanges(over)} Ma</b>.` : '.');
  }

  // ---------------------------------------------------------------------------
  // moving plates
  // ---------------------------------------------------------------------------
  function select(id) {
    state.selected = topOf(id);
    if (!state.visible[state.selected]) {
      state.visible[state.selected] = true;
      byId[state.selected].children.forEach(c => { state.visible[c] = true; });
    }
    syncControls(); changed();
  }
  function stepDeg() { return parseFloat($('#step').value); }

  function movePlate(dir, mult = 1) {
    const id = state.selected, q = state.q[id];
    const c = qRotate(q, byId[id].centroidV);
    const s = stepDeg() * mult;
    let dq;
    if (dir === 'E' || dir === 'W') dq = G.qAxisAngle(NP, dir === 'E' ? s : -s);
    else if (dir === 'N' || dir === 'S') {
      let axis = G.cross(c, NP);
      if (Math.hypot(...axis) < 1e-6) axis = [0, 1, 0];
      dq = G.qAxisAngle(axis, dir === 'N' ? s : -s);
    } else {
      dq = G.qAxisAngle(c, dir === 'CCW' ? s : -s);
    }
    pushHistory();
    state.q[id] = G.qNormalize(qMul(dq, q));
    movedOnce = true;
    changed();
  }

  function applyTypedRotation() {
    const lat = parseFloat($('#eu-lat').value), lon = parseFloat($('#eu-lon').value), ang = parseFloat($('#eu-ang').value);
    if (![lat, lon, ang].every(Number.isFinite) || Math.abs(lat) > 90) {
      toast('Enter an axis latitude (−90 to 90), longitude and angle in degrees.');
      return;
    }
    pushHistory();
    state.q[state.selected] = qEuler(lat, lon, ang);
    changed();
  }

  // ---------------------------------------------------------------------------
  // pointer interaction (no modes)
  // ---------------------------------------------------------------------------
  const pointers = new Map();
  let drag = null, pinch = null;

  function eventXY(ev) {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  /* unit vector under the pointer; outside the disk, the nearest limb point */
  function pointerVector(xy) {
    const [cx, cy] = projection.translate(), R = projection.scale();
    let dx = xy[0] - cx, dy = xy[1] - cy;
    const r = Math.hypot(dx, dy);
    if (r > R * 0.999) { dx *= R * 0.999 / r; dy *= R * 0.999 / r; }
    const g = projection.invert([cx + dx, cy + dy]);
    return g ? cart(g[1], g[0]) : null;
  }
  function plateAt(xy) {
    const g = projection.invert(xy);
    if (!g) return null;
    const [cx, cy] = projection.translate();
    if (Math.hypot(xy[0] - cx, xy[1] - cy) > projection.scale()) return null;
    const v = cart(g[1], g[0]);
    const order = ['SAM', 'GRN', 'NAM', 'IBE', 'EUR', 'AFR'];     // topmost first, as drawn
    for (const id of order) {
      if (!state.visible[id]) continue;
      const pv = qRotate(qConj(effectiveQ(id)), v);
      const geo = state.opts.shelf ? byId[id].shelfGeo : byId[id].landGeo;
      if (d3.geoContains(geo, ll(pv))) return id;
    }
    return null;
  }
  function focusPoleAt(xy) {
    let best = null, bd = Infinity;
    hitPoles.forEach(h => {
      if (h.kind !== 'pole' || !h.isFocus) return;
      const d = Math.hypot(h.x - xy[0], h.y - xy[1]);
      if (d <= h.r && d < bd) { best = h; bd = d; }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', ev => {
    canvas.setPointerCapture(ev.pointerId);
    const xy = eventXY(ev);
    pointers.set(ev.pointerId, xy);
    hideTooltip();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: state.view.zoom };
      drag = null;
      return;
    }
    const poleHit = focusPoleAt(xy);
    const hit = poleHit ? poleHit.plate.id : plateAt(xy);
    drag = { xy0: xy, moved: false, hit, rot0: projection.rotate().slice() };
    if (poleHit) {
      // grab the plate by its pole: the pole follows the pointer exactly
      if (topOf(hit) !== state.selected) select(hit);
      drag.mode = 'pole';
      drag.v0 = qRotate(state.q[state.selected], poleHit.pole.v);
      drag.q0 = state.q[state.selected].slice();
    } else if (hit) {
      if (topOf(hit) !== state.selected) select(hit);
      const v0 = pointerVector(xy);
      drag.mode = ev.shiftKey ? 'spin' : 'slide';
      drag.v0 = v0;
      drag.q0 = state.q[state.selected].slice();
      drag.c = qRotate(drag.q0, byId[state.selected].centroidV);
    } else {
      drag.mode = 'view';
    }
    stage.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', ev => {
    const xy = eventXY(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, xy);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      setZoom(pinch.z0 * d / pinch.d0);
      return;
    }
    if (!drag) { hover(xy); return; }
    const dx = xy[0] - drag.xy0[0], dy = xy[1] - drag.xy0[1];
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      if (drag.mode !== 'view') { pushHistory(); movedOnce = true; }
    }
    if (drag.mode === 'view') {
      const k = 75 / projection.scale();
      const r = drag.rot0;
      state.view.rotate = [r[0] + dx * k * 1.0, G.clamp(r[1] - dy * k * 1.0, -90, 90), 0];
      applyView(); changed();
    } else if (drag.mode === 'pole') {
      let v1 = pointerVector(xy);
      if (!v1) return;
      if (G.angle(v1, NP) < SNAP) v1 = NP.slice();          // snap onto the North Pole
      state.q[state.selected] = G.qNormalize(qMul(qBetween(drag.v0, v1), drag.q0));
      changed();
    } else if (drag.mode === 'slide') {
      const v1 = pointerVector(xy);
      if (!v1 || !drag.v0) return;
      state.q[state.selected] = G.qNormalize(qMul(qBetween(drag.v0, v1), drag.q0));
      changed();
    } else if (drag.mode === 'spin') {
      const v1 = pointerVector(xy);
      if (!v1 || !drag.v0) return;
      const a = G.signedAngleAbout(drag.v0, v1, drag.c);
      state.q[state.selected] = G.qNormalize(qMul(G.qAxisAngle(drag.c, a), drag.q0));
      changed();
    }
  });

  function endPointer(ev) {
    const wasTap = drag && !drag.moved;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    stage.classList.remove('dragging');
    // a tap (no drag) on a pole or a star shows its details; this is how touch screens "hover"
    if (wasTap && ev.type === 'pointerup') hover(eventXY(ev));
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!drag) hideTooltip(); });

  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    setZoom(state.view.zoom * Math.exp(-ev.deltaY * 0.0015));
  }, { passive: false });

  function setZoom(z) {
    state.view.zoom = G.clamp(z, 0.6, 8);
    applyView(); changed();
  }

  // tooltip & cursor ----------------------------------------------------------
  const tooltip = $('#tooltip');
  function hover(xy) {
    let best = null, bd = Infinity;
    hitPoles.forEach(h => {
      const d = Math.hypot(h.x - xy[0], h.y - xy[1]);
      if (d <= h.r + 3 && d < bd) { best = h; bd = d; }
    });
    // cursor: grab a pole, move a plate, or turn the globe (plate test throttled)
    if (best && best.kind === 'pole' && best.isFocus) canvas.style.cursor = 'grab';
    else {
      const now = performance.now();
      if (!hover.t || now - hover.t > 90) {
        hover.t = now;
        canvas.style.cursor = plateAt(xy) ? 'move' : 'grab';
      }
    }
    if (!best) { hideTooltip(); return; }
    let html = '';
    if (best.kind === 'pole') {
      const d = best.pole, [lat, lon] = sph(qRotate(state.q[best.plate.id], d.v));
      html = `<b>${best.plate.name}: ${d.age} Ma pole</b><br>` +
        `Now at ${fmtLat(lat)}, ${fmtLon(lon)} · 95% circle ${d.p95.toFixed(1)}°<br>` +
        `<span class="tt-muted">Present-day position ${fmtLat(d.lat)}, ${fmtLon(d.lon)}; ` +
        `mean age of the data ${d.meanAge.toFixed(1)} Ma (20 Myr window).` +
        `${best.isFocus ? ' Drag it to move ' + best.plate.name + '.' : ''}</span>`;
    } else if (best.kind === 'paleopole') {
      const d = best.pole;
      html = `<b>${d.name}</b> (${d.age} Ma)<br>95% circle ${d.a95 != null ? d.a95.toFixed(1) + '°' : 'n/a'}<br>` +
        `<span class="tt-muted">${d.ref}; igneous paleopole in the Vaes et al. (2023) database` +
        `${d.plateID ? ' (plate ' + d.plateID + ')' : ''}.</span>`;
    } else if (best.kind === 'site') {
      const n = siteNow(best.site);
      html = `<b>${best.site.name}</b><br>Latitude now: ${fmtLat(n.lat)}<br>` +
        `<span class="tt-muted">Present-day ${fmtLat(best.site.lat)}, ${fmtLon(best.site.lon)}</span>`;
    }
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    tooltip.style.left = Math.max(8, Math.min(xy[0] + 14, W - tw - 8)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(xy[1] + 14, H - th - 8)) + 'px';
  }
  function hideTooltip() { tooltip.hidden = true; }

  // ---------------------------------------------------------------------------
  // buttons and keyboard
  // ---------------------------------------------------------------------------
  function bind() {
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-reset').addEventListener('click', () => {
      pushHistory();
      topPlates.forEach(p => { state.q[p.id] = QI.slice(); });
      state.closed = { GRN: false, IBE: false };
      syncControls(); changed();
    });
    document.querySelectorAll('.setup-btn').forEach(b => b.addEventListener('click', () => applyPart(b.dataset.part)));
    $('#plate-reset').addEventListener('click', () => {
      pushHistory(); state.q[state.selected] = QI.slice(); changed();
    });
    $('#eu-apply').addEventListener('click', applyTypedRotation);
    ['#eu-lat', '#eu-lon', '#eu-ang'].forEach(s => $(s).addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applyTypedRotation(); }
    }));
    document.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', e => {
      movePlate(b.dataset.move, e.shiftKey ? 5 : 1);
    }));
    $('#opt-close').addEventListener('change', e => {
      pushHistory(); state.closed = { GRN: e.target.checked, IBE: e.target.checked }; syncControls(); changed();
    });
    $('#age').addEventListener('input', e => {
      state.age = +e.target.value; $('#age-out').textContent = `${state.age} Ma`; changed();
    });
    const ageRange = () => {
      let a = +$('#age-min').value, b = +$('#age-max').value;
      a = G.clamp(Math.round(a / 10) * 10, 0, AGE_MAX); b = G.clamp(Math.round(b / 10) * 10, 0, AGE_MAX);
      if (a > b) [a, b] = [b, a];
      state.ageMin = a; state.ageMax = b; changed();
    };
    $('#age-min').addEventListener('change', ageRange);
    $('#age-max').addEventListener('change', ageRange);
    const opt = (sel, key) => $(sel).addEventListener('change', e => { state.opts[key] = e.target.checked; changed(); });
    opt('#opt-paths', 'paths'); opt('#opt-circles', 'circles'); opt('#opt-allages', 'allAges');
    opt('#opt-paleopoles', 'paleopoles'); opt('#opt-graticule', 'graticule'); opt('#opt-ghost', 'ghost');
    opt('#opt-shelf', 'shelf'); opt('#opt-labels', 'labels'); opt('#opt-sites', 'sites');
    $('#pair').addEventListener('change', e => { state.pair = e.target.value; changed(); });
    $('#zoom-in').addEventListener('click', () => setZoom(state.view.zoom * 1.25));
    $('#zoom-out').addEventListener('click', () => setZoom(state.view.zoom / 1.25));
    $('#view-north').addEventListener('click', () => { state.view.rotate = [state.view.rotate[0], -90, 0]; applyView(); changed(); });
    $('#view-plate').addEventListener('click', () => {
      const [lat, lon] = sph(qRotate(state.q[state.selected], byId[state.selected].centroidV));
      state.view.rotate = [-lon, -lat, 0]; applyView(); changed();
    });
    $('#btn-help').addEventListener('click', () => { $('#help').hidden = false; $('#help-close').focus(); });
    $('#help-close').addEventListener('click', () => { $('#help').hidden = true; });
    $('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').hidden = true; });
    $('#btn-link').addEventListener('click', copyLink);
    $('#btn-snapshot').addEventListener('click', saveImage);
    const nameEl = $('#student-name');
    nameEl.value = safeStorage('get', 'ppg-name') || '';
    nameEl.addEventListener('input', () => safeStorage('set', 'ppg-name', nameEl.value));

    window.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea')) return;
      const mult = e.shiftKey ? 5 : 1;
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map = { ArrowUp: 'N', ArrowDown: 'S', ArrowLeft: 'W', ArrowRight: 'E', ',': 'CCW', '<': 'CCW', '.': 'CW', '>': 'CW' };
      if (map[k]) { e.preventDefault(); movePlate(map[k], mult); return; }
      if (k === 'Escape') $('#help').hidden = true;
    });

    if (INSTRUCTOR) {
      $('#instructor-card').hidden = false;
      $('#instructor-card').open = true;
      $('#ins-snap').addEventListener('click', () => {
        const f = focusPole(byId[state.selected].poleSet);
        if (!f) return;
        pushHistory();
        state.q[state.selected] = G.qNormalize(qMul(qBetween(f.rv, NP), state.q[state.selected]));
        changed();
      });
      $('#ins-fit').addEventListener('click', () => {
        // Africa is fitted to North America in Part B; in Part C Africa is the fixed plate
        const map = { AFR: ['AFR-NAM', 'NAM'], EUR: ['EUR-NAM', 'NAM'], SAM: ['SAM-AFR', 'AFR'] };
        const m = map[state.selected];
        if (!m) { toast('Select Africa, South America or Europe first.'); return; }
        const f = DATA.fits[m[0]];
        pushHistory();
        state.q[state.selected] = qMul(state.q[m[1]], qEuler(f.lat, f.lon, f.angle));
        changed();
      });
      $('#ins-pangea').addEventListener('click', () => {
        const rec = DATA.reference && DATA.reference.find(r => r.age === state.age);
        if (!rec) { toast('No reference reconstruction for this age.'); return; }
        pushHistory();
        Object.entries(rec.q).forEach(([id, q]) => { state.q[id] = q.slice(); });
        // Greenland reaches its pre-drift position in the circuit by ca. 100 Ma (Labrador
        // Sea rifting) and Iberia by 125 Ma (Bay of Biscay closed)
        state.closed = { GRN: state.age >= 100, IBE: state.age >= 130 };
        syncControls(); changed();
      });
    }

    $('#about').innerHTML =
      `<p><b>Reference poles:</b> ${DATA.meta.apwp}</p>` +
      `<p>Because every continent’s poles here come from one global path and one plate circuit, ` +
      `the old poles coincide exactly once the continents are fitted with that circuit. ` +
      `Real poles scatter: tick “Individual igneous paleopoles” under <i>More pole options</i> to see them.</p>` +
      `<p><b>Individual poles:</b> ${DATA.meta.paleopoles}</p>` +
      `<p><b>Outlines:</b> ${DATA.meta.outlines}</p>` +
      `<p>Built for ESCI 2201 (Solid Earth Dynamics), University of Minnesota. ` +
      `Inspired by <a href="https://www.gplates.org" target="_blank" rel="noopener">GPlates</a>; ` +
      `rendering with <a href="https://d3js.org" target="_blank" rel="noopener">d3</a>.</p>`;
  }

  // ---------------------------------------------------------------------------
  // links and images
  // ---------------------------------------------------------------------------
  function encodeState() {
    const s = {
      q: Object.fromEntries(Object.entries(state.q).map(([k, q]) => [k, q.map(x => +x.toFixed(6))])),
      g: state.closed.GRN ? 1 : 0, i: state.closed.IBE ? 1 : 0, s: state.selected, a: state.age, r: [state.ageMin, state.ageMax],
      p: state.poleVisible, h: state.visible, t: state.part,
      v: state.view.rotate.map(x => +x.toFixed(2)), z: +state.view.zoom.toFixed(3),
      o: state.opts, c: state.pair,
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(s)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeState(str) {
    try {
      const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      const s = JSON.parse(decodeURIComponent(escape(atob(b64))));
      if (s.t && PARTS[s.t]) applyPart(s.t, true);
      else applyPart('all', true);         // links made before the set-up buttons showed every plate
      if (s.q) Object.keys(state.q).forEach(k => { if (s.q[k] && s.q[k].length === 4) state.q[k] = G.qNormalize(s.q[k]); });
      // links made before the two toggles were split carry only g (both sub-plates)
      state.closed = { GRN: !!s.g, IBE: s.i === undefined ? !!s.g : !!s.i };
      if (s.s && byId[s.s] && !byId[s.s].parent) state.selected = s.s;
      if (Number.isFinite(s.a)) state.age = G.clamp(s.a, 0, AGE_MAX);
      if (Array.isArray(s.r)) { state.ageMin = s.r[0]; state.ageMax = s.r[1]; }
      if (s.p) Object.assign(state.poleVisible, s.p);
      if (s.h) Object.keys(state.visible).forEach(k => { if (k in s.h) state.visible[k] = !!s.h[k]; });
      if (Array.isArray(s.v)) state.view.rotate = s.v;
      if (Number.isFinite(s.z)) state.view.zoom = s.z;
      if (s.o) Object.assign(state.opts, s.o);
      if (s.c && PAIRS[s.c]) state.pair = s.c;
      movedOnce = true;
      return true;
    } catch (e) {
      console.warn('could not read the saved reconstruction in the link', e);
      return false;
    }
  }
  function copyLink() {
    const url = `${location.origin}${location.pathname}${location.search}#s=${encodeState()}`;
    const done = () => toast('Link copied: paste it anywhere to reopen this reconstruction.');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link:', url));
    } else {
      window.prompt('Copy this link:', url);
    }
    history.replaceState(null, '', url);
  }

  function saveImage() {
    const nameEl = $('#student-name');
    if (!nameEl.value.trim()) {
      const nm = window.prompt('Your name (printed on the image):', '');
      if (nm) { nameEl.value = nm; safeStorage('set', 'ppg-name', nm); }
    }
    const scale = 2, infoW = 330;
    const out = document.createElement('canvas');
    out.width = (W + infoW) * scale; out.height = Math.max(H, 520) * scale;
    const c = out.getContext('2d');
    c.fillStyle = '#0c1622'; c.fillRect(0, 0, out.width, out.height);
    // redraw the globe at the export resolution
    draw(c, scale);
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.fillStyle = '#ffffff'; c.fillRect(W, 0, infoW, Math.max(H, 520));
    let y = 26;
    const line = (txt, size = 12, weight = 400, color = '#1b2733') => {
      c.font = `${weight} ${size}px system-ui, -apple-system, Arial, sans-serif`;
      c.fillStyle = color; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.fillText(txt, W + 16, y); y += size + 7;
    };
    line('PaleopoleGlobe', 17, 700);
    if (DATA.meta.title) line(DATA.meta.title, 12, 600, '#4a5866');
    const nm = nameEl.value.trim();
    if (nm) line(nm, 13, 600);
    line(new Date().toLocaleString(), 11, 400, '#6b7885');
    y += 6;
    line(`Focus age: ${state.age} Ma`, 13, 650);
    line('Total rotation from present day', 12.5, 650);
    topPlates.forEach(pl => {
      if (!state.visible[pl.id]) return;
      const e = qToEuler(state.q[pl.id]);
      line(`${pl.name}: ${e.angle === 0 ? 'present-day position' : fmtEuler(e)}`, 10.5);
    });
    if (state.visible.NAM || state.visible.EUR) {
      line(`Labrador Sea and Bay of Biscay: ${state.closed.GRN && state.closed.IBE ? 'closed' : 'open (present day)'}`, 10.5);
    }
    y += 6;
    line('Focus-age poles (distance from N pole)', 12.5, 650);
    topPlates.forEach(pl => {
      if (!state.poleVisible[pl.poleSet] || !state.visible[pl.id]) return;
      const f = focusPole(pl.poleSet);
      if (f) line(`${pl.name}: ${f.dist.toFixed(1)}°`, 11.5);
    });
    y += 6;
    line('Sites now (latitude; turned since then)', 12.5, 650);
    sites.forEach(s => {
      if (!state.visible[s.plate]) return;
      const n = siteNow(s);
      line(`${s.name}: ${fmtLat(n.lat)}; ${sinceText(n.az, true)}`, 11.5);
    });
    y += 6;
    line('Relative rotations', 12.5, 650);
    [['AFR', 'NAM', 'Africa rel. to North America:'], ['EUR', 'NAM', 'Europe rel. to North America:']].forEach(([a, b, lab]) => {
      if (!(state.visible[a] && state.visible[b])) return;
      const r = relativeEuler(a, b);
      line(lab, 11.5);
      line(`  ${r.angle === 0 ? 'none' : fmtEuler(r)}`, 11);
    });
    if (state.visible.SAM && state.visible.AFR) {
      const r2 = relativeEuler('SAM', 'AFR');
      line('South America rel. to Africa:', 11.5);
      line(`  ${r2.angle === 0 ? 'none' : fmtEuler(r2)}`, 11);
    }
    const d = pairDistances(state.pair).filter(x => x.dist <= x.p95).map(x => x.age);
    const [pa, pb] = PAIRS[state.pair];
    y += 6;
    line(`Path match (${byId[pa].name} / ${byId[pb].name})`, 12.5, 650);
    line(`${d.length} ages overlap${d.length ? ': ' + ageRanges(d) + ' Ma' : ''}`, 11);
    // restore the on-screen canvas
    draw();
    out.toBlob(blob => {
      if (!blob) { toast('Could not create the image in this browser.'); return; }
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(blob);
      a.download = `paleopole-globe_${stamp}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Image saved to your downloads.');
    }, 'image/png');
  }

  // ---------------------------------------------------------------------------
  // legend & start-up
  // ---------------------------------------------------------------------------
  function drawLegend() {
    const lc = $('#legend-bar'), c = lc.getContext('2d');
    for (let i = 0; i < lc.width; i++) {
      c.fillStyle = ageColor(AGE_MAX * i / (lc.width - 1));
      c.fillRect(i, 0, 1, lc.height);
    }
  }

  function init() {
    if (DATA.meta.title) $('#scenario-name').textContent = ` · ${DATA.meta.title}`;
    if (!(location.hash.startsWith('#s=') && decodeState(location.hash.slice(3)))) applyPart('B', true);
    buildPlateList();
    bind();
    drawLegend();
    syncControls();
    new ResizeObserver(resize).observe(stage);
    resize();
    updatePanels();
    // expose for automated checks and debugging
    window.PPG = { state, changed, draw, applyView, applyPart, focusPole, siteNow, relativeEuler, pairDistances,
                   encodeState, select, movePlate, syncControls };
  }

  init();
})();
