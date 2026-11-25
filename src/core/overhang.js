/**
 * Overhang detection.
 *
 * Definition (same everywhere): with build direction d, a face is an
 * overhang if the angle between its normal and -d is less than
 * (90 - threshold). With the default threshold of 50 deg, a face counts when
 * it faces within 40 deg of straight down, i.e. it leans more than 50 deg
 * away from vertical.
 *
 * Faces lying ON the segment's base (the bed, or the cut face the segment
 * sits on) are never overhangs: they are supported.
 */

import { dot, normalize } from './vec.js';

/**
 * Array of booleans, one per face: true where the face is an overhang.
 * @param {import('./mesh.js').TriMesh} mesh
 * @param {number[]} direction build direction (any length)
 * @param {number} thresholdDeg see above
 * @param {number} baseTol faces within this distance of the lowest point
 *                         (along d) count as "on the base" and are ignored
 */
export function overhangMask(mesh, direction, thresholdDeg = 50, baseTol = 1e-3) {
  const d = normalize(direction);
  const down = [-d[0], -d[1], -d[2]];
  const limit = Math.cos(((90 - thresholdDeg) * Math.PI) / 180);

  // Lowest vertex height along d = the base plane.
  let base = Infinity;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) base = Math.min(base, p[i] * d[0] + p[i + 1] * d[1] + p[i + 2] * d[2]);

  const mask = new Array(mesh.numFaces).fill(false);
  for (let f = 0; f < mesh.numFaces; f++) {
    if (dot(mesh.faceNormal(f), down) <= limit) continue; // not facing down enough
    const onBase = mesh.triangle(f).every((v) => dot(v, d) < base + baseTol);
    mask[f] = !onBase;
  }
  return mask;
}

/** Total area (mm^2) of overhang faces. */
export function overhangArea(mesh, direction, thresholdDeg = 50) {
  const mask = overhangMask(mesh, direction, thresholdDeg);
  const areas = mesh.faceAreas();
  return mask.reduce((sum, isOver, f) => (isOver ? sum + areas[f] : sum), 0);
}
