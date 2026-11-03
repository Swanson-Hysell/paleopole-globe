/* Spherical geometry and finite rotations for PaleopoleGlobe.
 *
 * Points are unit vectors [x, y, z] with x toward (0 N, 0 E), y toward
 * (0 N, 90 E) and z toward the north pole. Rotations are unit quaternions
 * [w, x, y, z]. A plate's rotation q takes its present-day coordinates to its
 * reconstructed position: v' = q v q*. Euler rotations follow the usual plate
 * tectonic convention: a positive angle is counterclockwise when viewed from
 * above the Euler pole (right-hand rule).
 */
(function (global) {
  'use strict';
  const DEG = Math.PI / 180;

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function cart(lat, lon) {
    const p = lat * DEG, l = lon * DEG, c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
  }

  /* [lat, lon] in degrees, lon in (-180, 180] */
  function sph(v) {
    const r = Math.hypot(v[0], v[1], v[2]);
    return [Math.asin(clamp(v[2] / r, -1, 1)) / DEG, Math.atan2(v[1], v[0]) / DEG];
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { const r = Math.hypot(a[0], a[1], a[2]); return r ? [a[0] / r, a[1] / r, a[2] / r] : [0, 0, 1]; }

  /* great-circle distance in degrees */
  function angle(a, b) {
    return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) / DEG;
  }

  const QI = [1, 0, 0, 0];

  function qAxisAngle(axis, deg) {
    const a = norm(axis), h = deg * DEG / 2, s = Math.sin(h);
    return [Math.cos(h), a[0] * s, a[1] * s, a[2] * s];
  }

  function qEuler(lat, lon, deg) { return qAxisAngle(cart(lat, lon), deg); }

  function qMul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
  }

  function qConj(q) { return [q[0], -q[1], -q[2], -q[3]]; }

  function qNormalize(q) {
    const r = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / r, q[1] / r, q[2] / r, q[3] / r];
  }

  /* 3x3 rotation matrix (row-major) of a quaternion */
  function qMatrix(q) {
    const [w, x, y, z] = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
  }

  function mApply(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  }

  function qRotate(q, v) { return mApply(qMatrix(q), v); }

  /* shortest rotation taking unit vector a to unit vector b */
  function qBetween(a, b) {
    const c = cross(a, b), s = Math.hypot(...c), d = dot(a, b);
    if (s < 1e-12) {
      if (d > 0) return QI.slice();
      const perp = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
      return qAxisAngle(perp, 180);
    }
    return qAxisAngle(c, Math.atan2(s, d) / DEG);
  }

  /* Euler pole and angle of a rotation, quoted with a Northern Hemisphere
     pole and a signed angle in (-180, 180] (the GPlates convention). */
  function qToEuler(q) {
    let [w, x, y, z] = qNormalize(q);
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }       // angle in [0, 180]
    const s = Math.hypot(x, y, z);
    let ang = 2 * Math.atan2(s, w) / DEG;
    if (s < 1e-10 || ang < 1e-6) return { lat: 90, lon: 0, angle: 0 };
    let [lat, lon] = sph([x / s, y / s, z / s]);
    if (lat < 0) { lat = -lat; lon = lon > 0 ? lon - 180 : lon + 180; ang = -ang; }
    return { lat, lon, angle: ang };
  }

  /* signed angle (deg) from a to b measured counterclockwise about axis c */
  function signedAngleAbout(a, b, c) {
    const pa = norm([a[0] - dot(a, c) * c[0], a[1] - dot(a, c) * c[1], a[2] - dot(a, c) * c[2]]);
    const pb = norm([b[0] - dot(b, c) * c[0], b[1] - dot(b, c) * c[1], b[2] - dot(b, c) * c[2]]);
    return Math.atan2(dot(c, cross(pa, pb)), dot(pa, pb)) / DEG;
  }

  /* initial azimuth (deg clockwise from north) of the great circle a -> b */
  function azimuth(a, b) {
    const [la, lo] = sph(a), [lb, lob] = sph(b);
    const p1 = la * DEG, p2 = lb * DEG, dl = (lob - lo) * DEG;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) / DEG) + 360) % 360;
  }

  global.GeoMath = {
    DEG, clamp, cart, sph, dot, cross, norm, angle, QI, qAxisAngle, qEuler, qMul,
    qConj, qNormalize, qMatrix, mApply, qRotate, qBetween, qToEuler,
    signedAngleAbout, azimuth,
  };
})(typeof window !== 'undefined' ? window : globalThis);
