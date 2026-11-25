/**
 * TriMesh: a simple triangle mesh, plus a few shape builders.
 *
 *   positions: Float64Array [x0,y0,z0, x1,y1,z1, ...]   (one entry per vertex)
 *   indices:   Uint32Array  [a0,b0,c0, a1,b1,c1, ...]   (3 vertex numbers per triangle)
 *
 * Triangles are counter-clockwise when seen from outside, so face normals
 * point outward. Meshes are treated as read-only: every operation returns a
 * new mesh, which lets us cache normals/areas safely.
 */

import { cross, dot, norm, sub } from './vec.js';
import { transformPositions } from './transforms.js';

export class TriMesh {
  /**
   * @param {ArrayLike<number>} positions
   * @param {ArrayLike<number>} indices
   */
  constructor(positions, indices) {
    this.positions = positions instanceof Float64Array ? positions : Float64Array.from(positions);
    this.indices = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    this._cache = {};
  }

  get numVerts() { return this.positions.length / 3; }
  get numFaces() { return this.indices.length / 3; }

  vertex(i) {
    const p = this.positions;
    return [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
  }

  /** The three corner points of face f. */
  triangle(f) {
    const ix = this.indices;
    return [this.vertex(ix[3 * f]), this.vertex(ix[3 * f + 1]), this.vertex(ix[3 * f + 2])];
  }

  /** Unit normal of every face, as a flat Float64Array (3 per face). */
  faceNormals() {
    if (!this._cache.normals) this._computeFaceData();
    return this._cache.normals;
  }

  faceNormal(f) {
    const n = this.faceNormals();
    return [n[3 * f], n[3 * f + 1], n[3 * f + 2]];
  }

  /** Area of every face (mm^2). */
  faceAreas() {
    if (!this._cache.areas) this._computeFaceData();
    return this._cache.areas;
  }

  /** Centre point of face f. */
  faceCenter(f) {
    const [a, b, c] = this.triangle(f);
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  }

  _computeFaceData() {
    const F = this.numFaces;
    const normals = new Float64Array(3 * F);
    const areas = new Float64Array(F);
    for (let f = 0; f < F; f++) {
      const [a, b, c] = this.triangle(f);
      const n = cross(sub(b, a), sub(c, a));
      const len = norm(n);
      areas[f] = len / 2;
      if (len > 0) {
        normals[3 * f] = n[0] / len;
        normals[3 * f + 1] = n[1] / len;
        normals[3 * f + 2] = n[2] / len;
      }
    }
    this._cache.normals = normals;
    this._cache.areas = areas;
  }

  /** { min: [x,y,z], max: [x,y,z] } */
  bounds() {
    if (!this._cache.bounds) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      const p = this.positions;
      for (let i = 0; i < p.length; i += 3)
        for (let k = 0; k < 3; k++) {
          if (p[i + k] < min[k]) min[k] = p[i + k];
          if (p[i + k] > max[k]) max[k] = p[i + k];
        }
      this._cache.bounds = { min, max };
    }
    return this._cache.bounds;
  }

  /** Size along x, y, z. */
  extents() {
    const { min, max } = this.bounds();
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  }

  /** Centre of the bounding box. */
  boundsCenter() {
    const { min, max } = this.bounds();
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }

  /** Enclosed volume (mm^3). Only meaningful for closed meshes. */
  volume() {
    let v = 0;
    for (let f = 0; f < this.numFaces; f++) {
      const [a, b, c] = this.triangle(f);
      v += dot(a, cross(b, c)) / 6;
    }
    return v;
  }

  /** Centre of mass of the solid (falls back to bounding-box centre). */
  centroid() {
    let v = 0;
    const c = [0, 0, 0];
    for (let f = 0; f < this.numFaces; f++) {
      const [a, b, d] = this.triangle(f);
      const tv = dot(a, cross(b, d)) / 6; // signed volume of tetra (origin, a, b, d)
      v += tv;
      for (let k = 0; k < 3; k++) c[k] += (tv * (a[k] + b[k] + d[k])) / 4;
    }
    return Math.abs(v) < 1e-12 ? this.boundsCenter() : c.map((x) => x / v);
  }

  totalArea() {
    return this.faceAreas().reduce((s, a) => s + a, 0);
  }

  /**
   * True if every edge is shared by exactly two faces that use it in opposite
   * directions (the mesh is a closed, consistently oriented surface).
   */
  isWatertight() {
    const edges = new Map();
    const ix = this.indices;
    for (let f = 0; f < this.numFaces; f++)
      for (let k = 0; k < 3; k++) {
        const key = `${ix[3 * f + k]},${ix[3 * f + ((k + 1) % 3)]}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    for (const [key, count] of edges) {
      if (count !== 1) return false;
      const [a, b] = key.split(',');
      if (edges.get(`${b},${a}`) !== 1) return false;
    }
    return edges.size > 0;
  }

  /** New mesh: rotate by R about `center`, then move by `offset`. */
  transformed(R, center = [0, 0, 0], offset = [0, 0, 0]) {
    return new TriMesh(transformPositions(this.positions, R, center, offset), this.indices);
  }

  translated(offset) {
    const p = Float64Array.from(this.positions);
    for (let i = 0; i < p.length; i += 3) {
      p[i] += offset[0];
      p[i + 1] += offset[1];
      p[i + 2] += offset[2];
    }
    return new TriMesh(p, this.indices);
  }

  /** New mesh with every triangle's winding reversed (normals flipped). */
  flipped() {
    const ix = Uint32Array.from(this.indices);
    for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
    return new TriMesh(this.positions, ix);
  }

  /**
   * Build a mesh from separate triangles (9 numbers each, as stored in STL
   * files), merging corners that are at the same position.
   */
  static fromTriangleSoup(coords) {
    const map = new Map();
    const positions = [];
    const indices = new Uint32Array(coords.length / 3);
    for (let i = 0; i < coords.length; i += 3) {
      // Round to 0.1 micron so tiny float noise doesn't stop corners merging.
      const key = `${Math.round(coords[i] * 1e4)},${Math.round(coords[i + 1] * 1e4)},${Math.round(coords[i + 2] * 1e4)}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = positions.length / 3;
        map.set(key, idx);
        positions.push(coords[i], coords[i + 1], coords[i + 2]);
      }
      indices[i / 3] = idx;
    }
    // Drop triangles that collapsed to a line or point after merging.
    const kept = [];
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    return new TriMesh(positions, kept);
  }

  /** Join several meshes into one (no boolean union - just side by side). */
  static concat(meshes) {
    const pos = [], idx = [];
    let offset = 0;
    for (const m of meshes) {
      pos.push(...m.positions);
      for (const i of m.indices) idx.push(i + offset);
      offset += m.numVerts;
    }
    return new TriMesh(pos, idx);
  }

  // ------------------------------------------------------------------ //
  // Shape builders
  // ------------------------------------------------------------------ //

  /** Axis-aligned box given its size [sx,sy,sz] and its minimum corner. */
  static box(size, minCorner = [0, 0, 0]) {
    const [x0, y0, z0] = minCorner;
    const [x1, y1, z1] = [x0 + size[0], y0 + size[1], z0 + size[2]];
    const p = [
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // bottom 0-3
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // top 4-7
    ];
    const f = [
      0, 2, 1, 0, 3, 2, // bottom (-Z)
      4, 5, 6, 4, 6, 7, // top (+Z)
      0, 1, 5, 0, 5, 4, // front (-Y)
      2, 3, 7, 2, 7, 6, // back (+Y)
      1, 2, 6, 1, 6, 5, // right (+X)
      3, 0, 4, 3, 4, 7, // left (-X)
    ];
    return new TriMesh(p, f);
  }

  /** Box of the given size centred on `center`. */
  static centeredBox(size, center = [0, 0, 0]) {
    return TriMesh.box(size, [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2]);
  }

  /**
   * Closed frustum (cone or cylinder) around the Z axis from zBottom to zTop.
   * A radius of 0 makes a pointed end.
   */
  static frustum(rBottom, rTop, zBottom, zTop, sections = 32) {
    const pos = [], idx = [];
    const ring = (r, z) => {
      if (r === 0) {
        pos.push(0, 0, z);
        return [pos.length / 3 - 1];
      }
      const start = pos.length / 3;
      for (let i = 0; i < sections; i++) {
        const a = (2 * Math.PI * i) / sections;
        pos.push(r * Math.cos(a), r * Math.sin(a), z);
      }
      return Array.from({ length: sections }, (_, i) => start + i);
    };
    const bottom = ring(rBottom, zBottom);
    const top = ring(rTop, zTop);
    const at = (r, i) => (r.length === 1 ? r[0] : r[i % sections]);
    // Sides
    for (let i = 0; i < sections; i++) {
      const b0 = at(bottom, i), b1 = at(bottom, i + 1), t0 = at(top, i), t1 = at(top, i + 1);
      if (b0 !== b1) idx.push(b0, b1, t1);
      if (t0 !== t1) idx.push(b0, t1, t0);
    }
    // Flat caps (a fan around a centre vertex)
    if (bottom.length > 1) {
      pos.push(0, 0, zBottom);
      const c = pos.length / 3 - 1;
      for (let i = 0; i < sections; i++) idx.push(c, at(bottom, i + 1), at(bottom, i));
    }
    if (top.length > 1) {
      pos.push(0, 0, zTop);
      const c = pos.length / 3 - 1;
      for (let i = 0; i < sections; i++) idx.push(c, at(top, i), at(top, i + 1));
    }
    return new TriMesh(pos, idx);
  }
}

