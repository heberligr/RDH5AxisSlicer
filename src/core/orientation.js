/**
 * Choosing how the part sits on the bed ("base orientation").
 *
 * Candidates: every large flat face put face-down, plus directions spread
 * evenly over a sphere. For each candidate "up" direction we measure the
 * overhang area and how much of the part touches the bed. Orientations that
 * barely touch the bed are rejected (they'd fall over / not stick); of the
 * rest, the one with the least overhang wins.
 */

import { overhangArea } from './overhang.js';
import { rotationBetween } from './transforms.js';
import { dot, normalize } from './vec.js';

/** Evenly spread unit vectors on a sphere (Fibonacci spiral). */
export function fibonacciSphere(n) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    out.push([r * Math.cos(golden * i), r * Math.sin(golden * i), z]);
  }
  return out;
}

/** Area of the faces lying flat on the bed if `up` points up. */
export function contactArea(mesh, up, tol = 0.05) {
  const d = normalize(up);
  let base = Infinity;
  for (let v = 0; v < mesh.numVerts; v++) base = Math.min(base, dot(mesh.vertex(v), d));
  const areas = mesh.faceAreas();
  let area = 0;
  for (let f = 0; f < mesh.numFaces; f++) {
    if (dot(mesh.faceNormal(f), d) > -0.999) continue; // must face straight down
    if (mesh.triangle(f).every((v) => dot(v, d) < base + tol)) area += areas[f];
  }
  return area;
}

/** Normals of the biggest flat areas (faces grouped by normal), largest first. */
function largeFlatFaces(mesh, count = 12) {
  const groups = new Map();
  const areas = mesh.faceAreas();
  for (let f = 0; f < mesh.numFaces; f++) {
    const n = mesh.faceNormal(f);
    const key = n.map((x) => Math.round(x * 100)).join(',');
    const g = groups.get(key) ?? { normal: n, area: 0 };
    g.area += areas[f];
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.area - a.area).slice(0, count).map((g) => g.normal);
}

/**
 * Find the best base orientation.
 * @returns {{ rotation: number[][], up: number[], overhang: number, contact: number,
 *             current: { overhang: number, contact: number }, candidates: object[] }}
 *   `rotation` turns the mesh so `up` becomes +Z.
 */
export function chooseOrientation(mesh, settings) {
  const threshold = settings.overhang.threshold_deg;
  const minContact = settings.orientation.min_contact_area;
  const ups = [
    [0, 0, 1], // current orientation first, so it wins ties
    ...largeFlatFaces(mesh).map((n) => n.map((x) => -x)),
    ...fibonacciSphere(settings.orientation.sphere_samples),
  ];
  const candidates = ups.map((up) => ({
    up: normalize(up),
    overhang: overhangArea(mesh, up, threshold),
    contact: contactArea(mesh, up),
  }));
  const ok = candidates.filter((c) => c.contact >= minContact);
  const pool = ok.length ? ok : candidates;
  // Least overhang; within 0.5 mm^2, the bigger bed contact; then list order.
  const best = pool.reduce((a, b) => (b.overhang < a.overhang - 0.5 || (Math.abs(b.overhang - a.overhang) <= 0.5 && b.contact > a.contact + 0.5) ? b : a));
  return {
    rotation: rotationBetween(best.up, [0, 0, 1]),
    up: best.up,
    overhang: best.overhang,
    contact: best.contact,
    current: { overhang: candidates[0].overhang, contact: candidates[0].contact },
    candidates,
  };
}
