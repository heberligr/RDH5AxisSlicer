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

/**
 * Group overhang faces into connected regions (faces sharing an edge belong
 * to the same region). Regions smaller than `minArea` are dropped.
 * Returns [{ faces, area, centroid }], biggest first. `centroid` is the
 * area-weighted centre of the region's faces.
 */
export function overhangRegions(mesh, direction, thresholdDeg = 50, minArea = 0) {
  const mask = overhangMask(mesh, direction, thresholdDeg);
  const parent = mesh.indices.length ? Array.from({ length: mesh.numFaces }, (_, i) => i) : [];
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]; // path halving
    return i;
  };
  // Connect overhang faces that share an edge.
  const edgeOwner = new Map();
  const ix = mesh.indices;
  for (let f = 0; f < mesh.numFaces; f++) {
    if (!mask[f]) continue;
    for (let k = 0; k < 3; k++) {
      const a = ix[3 * f + k], b = ix[3 * f + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = edgeOwner.get(key);
      if (other === undefined) edgeOwner.set(key, f);
      else parent[find(f)] = find(other);
    }
  }
  const groups = new Map();
  for (let f = 0; f < mesh.numFaces; f++) {
    if (!mask[f]) continue;
    const r = find(f);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  }
  const areas = mesh.faceAreas();
  const regions = [];
  for (const faces of groups.values()) {
    let area = 0;
    const c = [0, 0, 0];
    for (const f of faces) {
      const fc = mesh.faceCenter(f);
      area += areas[f];
      for (let k = 0; k < 3; k++) c[k] += fc[k] * areas[f];
    }
    if (area < minArea || area === 0) continue;
    regions.push({ faces, area, centroid: c.map((x) => x / area) });
  }
  return regions.sort((a, b) => b.area - a.area);
}
