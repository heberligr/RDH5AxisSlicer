/**
 * Rotation helpers: rotations about the axes, "rotate direction d onto +Z"
 * and back, and rotating lots of points at once.
 * Angles are in degrees at the public API.
 */

import { DEG, clamp, cross, dot, identity, matVec, norm, normalize, transpose } from './vec.js';

export const Z_AXIS = [0, 0, 1];

/** Right-hand-rule rotation about +X by angleDeg. */
export function rotX(angleDeg) {
  const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

/** Right-hand-rule rotation about +Y by angleDeg. */
export function rotY(angleDeg) {
  const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

/** Right-hand-rule rotation about +Z by angleDeg. */
export function rotZ(angleDeg) {
  const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

/** Rodrigues' formula: rotation by angleRad about a (unit) axis. */
export function axisAngleMatrix(axis, angleRad) {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angleRad), s = Math.sin(angleRad), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/**
 * Smallest rotation R with R * u_hat = v_hat.
 * If u and v are exactly opposite, any 180 degree turn about an axis
 * perpendicular to u works; we pick one.
 */
export function rotationBetween(u, v) {
  u = normalize(u);
  v = normalize(v);
  const cosT = clamp(dot(u, v), -1, 1);
  const axis = cross(u, v);
  if (norm(axis) < 1e-9) {
    if (cosT > 0) return identity(); // already aligned
    // Opposite: cross u with the world axis it is least aligned with.
    const abs = u.map(Math.abs);
    const helper = [0, 0, 0];
    helper[abs.indexOf(Math.min(...abs))] = 1;
    return axisAngleMatrix(cross(u, helper), Math.PI);
  }
  return axisAngleMatrix(axis, Math.acos(cosT));
}

/** Rotation that takes `direction` onto +Z (used to lay a segment flat). */
export const rotationToZ = (direction) => rotationBetween(direction, Z_AXIS);

/** Rotation that takes +Z onto `direction` (inverse of rotationToZ). */
export const rotationFromZ = (direction) => transpose(rotationToZ(direction));

/** Rotate one point by R about `center` (origin if omitted). */
export function rotatePoint(p, R, center = [0, 0, 0]) {
  const q = matVec(R, [p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
  return [q[0] + center[0], q[1] + center[1], q[2] + center[2]];
}

/**
 * Rotate a flat list of coordinates [x0,y0,z0, x1,y1,z1, ...] by R about
 * `center`, then add `offset`. Returns a new Float64Array.
 */
export function transformPositions(positions, R, center = [0, 0, 0], offset = [0, 0, 0]) {
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] - center[0], y = positions[i + 1] - center[1], z = positions[i + 2] - center[2];
    out[i] = R[0][0] * x + R[0][1] * y + R[0][2] * z + center[0] + offset[0];
    out[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z + center[1] + offset[1];
    out[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z + center[2] + offset[2];
  }
  return out;
}

/**
 * Unit vector tilted `tiltDeg` away from +Z toward azimuth `azimuthDeg`
 * (azimuth 0 = toward +X, 90 = toward +Y). Handy for sliders and tests.
 */
export function directionFromAngles(tiltDeg, azimuthDeg) {
  const t = tiltDeg * DEG, a = azimuthDeg * DEG;
  return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)];
}

/** Inverse of directionFromAngles: returns { tilt, azimuth } in degrees. */
export function anglesOf(direction) {
  const d = normalize(direction);
  return {
    tilt: Math.acos(clamp(d[2], -1, 1)) / DEG,
    azimuth: Math.atan2(d[1], d[0]) / DEG,
  };
}
