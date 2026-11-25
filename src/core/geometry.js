/**
 * Mesh operations: plane cuts, connected pieces, unions, point queries.
 *
 * Cutting is done by the manifold-3d library (WebAssembly). It works on
 * "Manifold" solids that are always watertight, so cut results come out
 * capped automatically. We convert to/from TriMesh at the edges of this
 * module, so the rest of the code only ever sees TriMesh.
 *
 * Call `await initGeometry()` once at startup before using the cut/union
 * functions (it downloads and starts the WebAssembly module).
 *
 * Memory note: WebAssembly objects are NOT garbage collected, so every
 * Manifold we create is explicitly .delete()d when we're done with it.
 */

import Module from 'manifold-3d';
import { TriMesh } from './mesh.js';
import { add, cross, dot, normalize, scale, sub } from './vec.js';

let wasm = null;

/** Load the manifold library (safe to call more than once). */
export async function initGeometry() {
  if (!wasm) {
    wasm = await Module();
    wasm.setup();
  }
  return wasm;
}

function lib() {
  if (!wasm) throw new Error('Call initGeometry() before using geometry functions');
  return wasm;
}

// --------------------------------------------------------------------- //
// TriMesh <-> Manifold
// --------------------------------------------------------------------- //

/** Convert a TriMesh to a Manifold solid. Throws if it isn't a closed solid. */
export function toManifold(mesh) {
  const { Manifold, Mesh } = lib();
  const m = new Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(mesh.positions),
    triVerts: Uint32Array.from(mesh.indices),
  });
  m.merge(); // glue together corners that are at the same spot
  try {
    return new Manifold(m);
  } catch (err) {
    throw new Error(
      `Mesh is not a closed solid (${err.message ?? err}). Repair it (e.g. in PrusaSlicer or Meshmixer) before cutting.`,
    );
  }
}

/** Convert a Manifold back to a TriMesh. Does not delete the Manifold. */
export function toTriMesh(manifold) {
  const mesh = manifold.getMesh();
  const n = mesh.numProp;
  const positions = new Float64Array((mesh.vertProperties.length / n) * 3);
  for (let v = 0; v < positions.length / 3; v++)
    for (let k = 0; k < 3; k++) positions[3 * v + k] = mesh.vertProperties[n * v + k];
  return new TriMesh(positions, Uint32Array.from(mesh.triVerts));
}

/** Sort meshes by centroid (x, then y, then z) so piece numbers are repeatable. */
export function sortComponents(meshes) {
  const key = (m) => m.centroid().map((x) => Math.round(x * 1000) / 1000);
  return [...meshes].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

// --------------------------------------------------------------------- //
// Cutting and booleans
// --------------------------------------------------------------------- //

/**
 * Cut a solid with the plane through `point` with normal `normal`.
 * Returns { uppers, lower }:
 *   uppers: separate solids on the side the normal points to (each capped
 *           and watertight), in a stable order
 *   lower:  everything on the other side as one solid (null if empty)
 */
export function splitByPlane(mesh, point, normal) {
  const n = normalize(normal);
  const solid = toManifold(mesh);
  const [upper, lower] = solid.splitByPlane(n, dot(n, point)); // plane: n.x = offset
  const pieces = upper.decompose();
  const uppers = [];
  for (const p of pieces) {
    if (!p.isEmpty()) uppers.push(toTriMesh(p));
    p.delete();
  }
  const lowerMesh = lower.isEmpty() ? null : toTriMesh(lower);
  solid.delete();
  upper.delete();
  lower.delete();
  return { uppers: sortComponents(uppers), lower: lowerMesh };
}

/** Boolean union of solids (they may touch along a shared cut face). */
export function union(meshes) {
  if (meshes.length === 1) return meshes[0];
  const { Manifold } = lib();
  const solids = meshes.map(toManifold);
  const result = Manifold.union(solids);
  const out = toTriMesh(result);
  solids.forEach((s) => s.delete());
  result.delete();
  return out;
}

/** Split a solid into its separate pieces (stable order). */
export function components(mesh) {
  const solid = toManifold(mesh);
  const pieces = solid.decompose();
  const out = pieces.map(toTriMesh);
  pieces.forEach((p) => p.delete());
  solid.delete();
  return sortComponents(out);
}

// --------------------------------------------------------------------- //
// Point queries (plain JavaScript, no library needed)
// --------------------------------------------------------------------- //

/**
 * Generalised winding number of a closed mesh around `point`: about 1 if the
 * point is inside, 0 outside, 0.5 on the surface. Adds up the solid angle of
 * every triangle as seen from the point (Van Oosterom & Strackee formula).
 */
export function windingNumber(mesh, point) {
  let total = 0;
  for (let f = 0; f < mesh.numFaces; f++) {
    const [A, B, C] = mesh.triangle(f);
    const a = sub(A, point), b = sub(B, point), c = sub(C, point);
    const la = Math.hypot(...a), lb = Math.hypot(...b), lc = Math.hypot(...c);
    const det = dot(a, cross(b, c));
    const denom = la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
    total += 2 * Math.atan2(det, denom);
  }
  return total / (4 * Math.PI);
}

/** True if `point` is inside the closed mesh. */
export const contains = (mesh, point) => windingNumber(mesh, point) > 0.5;

/** Closest point to p on triangle (a, b, c). From Ericson, "Real-Time Collision Detection". */
export function closestPointOnTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/** Shortest distance from `point` to the mesh surface (checks every triangle). */
export function distanceToSurface(mesh, point) {
  let best = Infinity;
  for (let f = 0; f < mesh.numFaces; f++) {
    const [a, b, c] = mesh.triangle(f);
    const q = closestPointOnTriangle(point, a, b, c);
    best = Math.min(best, Math.hypot(q[0] - point[0], q[1] - point[1], q[2] - point[2]));
  }
  return best;
}

/**
 * Indices of faces lying in a plane and facing a given way.
 * facing = -1 finds faces whose normal is opposite the plane normal (the
 * bottom cap of a segment sitting on that plane); +1 finds the top cap.
 */
export function facesOnPlane(mesh, point, normal, tol = 1e-3, facing = -1) {
  const n = normalize(normal);
  const offset = dot(n, point);
  const out = [];
  for (let f = 0; f < mesh.numFaces; f++) {
    const tri = mesh.triangle(f);
    if (!tri.every((v) => Math.abs(dot(n, v) - offset) < tol)) continue;
    if (dot(mesh.faceNormal(f), n) * facing > 0.99) out.push(f);
  }
  return out;
}

/** Area shared by all the given 2D cross-sections (manifold CrossSection objects). */
export function intersectSections(sections) {
  return lib().CrossSection.intersection(sections);
}
