/**
 * Reading/writing STL files and placing parts on the bed.
 */

import { TriMesh } from './mesh.js';

/**
 * Parse an STL file (binary or ASCII) into a TriMesh.
 * Units are assumed to be millimetres, as is standard for STL.
 * @param {ArrayBuffer} buffer
 */
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // A binary STL is exactly 84 + 50 * triangleCount bytes long. (ASCII files
  // start with "solid", but some binary files do too, so we check the size.)
  let coords;
  if (bytes.length >= 84 && 84 + 50 * view.getUint32(80, true) === bytes.length) {
    const n = view.getUint32(80, true);
    coords = new Float64Array(n * 9);
    for (let t = 0; t < n; t++) {
      const base = 84 + 50 * t + 12; // skip the stored normal (12 bytes)
      for (let k = 0; k < 9; k++) coords[t * 9 + k] = view.getFloat32(base + 4 * k, true);
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const nums = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m;
    while ((m = re.exec(text)) !== null) nums.push(+m[1], +m[2], +m[3]);
    coords = Float64Array.from(nums);
  }
  if (coords.length === 0) throw new Error('The file does not contain any triangles');
  let mesh = TriMesh.fromTriangleSoup(coords);
  // Some exporters write the triangles inside-out; flip them if so.
  if (mesh.volume() < 0) mesh = mesh.flipped();
  return mesh;
}

/** Write a TriMesh as a binary STL. Returns an ArrayBuffer. */
export function exportSTL(mesh) {
  const n = mesh.numFaces;
  const buffer = new ArrayBuffer(84 + 50 * n);
  const view = new DataView(buffer);
  view.setUint32(80, n, true);
  const normals = mesh.faceNormals();
  for (let f = 0; f < n; f++) {
    const base = 84 + 50 * f;
    for (let k = 0; k < 3; k++) view.setFloat32(base + 4 * k, normals[3 * f + k], true);
    const tri = mesh.triangle(f);
    for (let v = 0; v < 3; v++)
      for (let k = 0; k < 3; k++) view.setFloat32(base + 12 + 12 * v + 4 * k, tri[v][k], true);
  }
  return buffer;
}

/**
 * Move a mesh so it sits on the table, centred on the C axis: the lowest
 * point goes to table.surface_z, and the XY centre of the bounding box goes
 * to the pivot's XY. Keeping the part near the rotary axes keeps tilted moves
 * inside the XYZ travel limits.
 */
export function placeOnBed(mesh, machine) {
  const { min, max } = mesh.bounds();
  const pivot = machine.kinematics.pivot;
  return mesh.translated([
    pivot[0] - (min[0] + max[0]) / 2,
    pivot[1] - (min[1] + max[1]) / 2,
    machine.table.surface_z - min[2],
  ]);
}

/** Lines of text describing a mesh, for the side panel. */
export function meshInfo(mesh, label) {
  const e = mesh.extents();
  const watertight = mesh.isWatertight();
  const lines = [
    `File: ${label}`,
    `Triangles: ${mesh.numFaces}`,
    `Size: ${e[0].toFixed(1)} x ${e[1].toFixed(1)} x ${e[2].toFixed(1)} mm`,
    watertight ? `Volume: ${(mesh.volume() / 1000).toFixed(2)} cm³` : 'Volume: n/a',
  ];
  if (!watertight) lines.push('WARNING: mesh is not watertight - cuts may fail.');
  return lines;
}

// ---------------------------------------------------------------------- //
// base64 helpers (used to store the STL inside project files)
// ---------------------------------------------------------------------- //
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000; // build the string in chunks to avoid stack limits
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
