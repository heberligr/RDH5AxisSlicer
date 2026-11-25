import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../src/core/geometry.js';
import { TriMesh } from '../src/core/mesh.js';
import { exportSTL, parseSTL, placeOnBed } from '../src/core/meshIO.js';
import { approx, loadMachine } from './helpers.js';

before(() => geometry.initGeometry());
const box = () => TriMesh.box([20, 10, 10], [-10, -5, 0]);

test('box primitive is a watertight solid', () => {
  assert.equal(box().isWatertight(), true);
  approx(box().volume(), 2000, 1e-9);
});

test('split volumes add up and both sides are capped', () => {
  const { uppers, lower } = geometry.splitByPlane(box(), [4, 0, 0], [1, 0, 0]);
  assert.equal(uppers.length, 1);
  approx(uppers[0].volume(), 600, 1e-3);
  approx(lower.volume(), 1400, 1e-3);
  assert.ok(uppers[0].isWatertight() && lower.isWatertight());
});

test('tilted split is watertight and conserves volume', () => {
  const { uppers, lower } = geometry.splitByPlane(box(), [0, 0, 5], [1, 0.3, 0.8]);
  assert.ok(uppers.every((u) => u.isWatertight()) && lower.isWatertight());
  approx(uppers.reduce((s, u) => s + u.volume(), 0) + lower.volume(), 2000, 1e-2);
});

test('plane missing the mesh', () => {
  const { uppers, lower } = geometry.splitByPlane(box(), [100, 0, 0], [1, 0, 0]);
  assert.equal(uppers.length, 0);
  assert.ok(lower !== null);
});

test('union restores the original', () => {
  const { uppers, lower } = geometry.splitByPlane(box(), [4, 0, 0], [1, 0, 0]);
  const back = geometry.union([lower, ...uppers]);
  approx(back.volume(), 2000, 1e-2);
  assert.equal(geometry.components(back).length, 1);
});

test('winding number: inside, outside', () => {
  approx(geometry.windingNumber(box(), [0, 0, 5]), 1, 1e-9);
  approx(geometry.windingNumber(box(), [50, 0, 5]), 0, 1e-9);
  assert.equal(geometry.contains(box(), [9.9, 4.9, 0.1]), true);
  assert.equal(geometry.contains(box(), [10.1, 0, 5]), false);
});

test('distance to surface', () => {
  approx(geometry.distanceToSurface(box(), [15, 0, 5]), 5, 1e-9);
  approx(geometry.distanceToSurface(box(), [0, 0, 5]), 5, 1e-9); // inside: nearest face 5 mm away
  approx(geometry.distanceToSurface(box(), [12, 7, 13]), Math.hypot(2, 2, 3), 1e-9); // nearest a corner
});

test('faces on plane', () => {
  assert.equal(geometry.facesOnPlane(box(), [0, 0, 10], [0, 0, 1], 1e-3, +1).length, 2);
  assert.equal(geometry.facesOnPlane(box(), [0, 0, 0], [0, 0, 1], 1e-3, -1).length, 2);
});

test('open mesh is rejected with a clear message', () => {
  const b = box();
  const open = new TriMesh(b.positions, b.indices.slice(0, b.indices.length - 3)); // remove one triangle
  assert.throws(() => geometry.toManifold(open), /closed solid/);
});

test('STL round trip (binary) and ASCII parsing', () => {
  const back = parseSTL(exportSTL(box()));
  assert.equal(back.numFaces, 12);
  assert.equal(back.isWatertight(), true);
  approx(back.volume(), 2000, 1e-3);
  const ascii = `solid t
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid t`;
  assert.equal(parseSTL(new TextEncoder().encode(ascii).buffer).numFaces, 1);
});

test('inside-out STL gets flipped', () => {
  approx(parseSTL(exportSTL(box().flipped())).volume(), 2000, 1e-3);
});

test('place on bed', () => {
  const m = loadMachine();
  const placed = placeOnBed(box().translated([100, -50, 7]), m);
  const { min, max } = placed.bounds();
  approx(min[2], m.table.surface_z, 1e-9);
  approx([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2], m.kinematics.pivot.slice(0, 2), 1e-9);
});
