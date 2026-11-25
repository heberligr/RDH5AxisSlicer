import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../src/core/geometry.js';
import { cube, cubeWithArm, tShape } from '../src/core/demoModels.js';
import { TriMesh } from '../src/core/mesh.js';
import { overhangArea } from '../src/core/overhang.js';
import { Cut, applyCuts, printOrder, tiltDeg } from '../src/core/segments.js';
import { approx, loadMachine } from './helpers.js';

before(() => geometry.initGeometry());

/** Slab with two posts at x = -15 and x = +15 (a "U" with square posts). */
function twoTowers() {
  const slab = TriMesh.box([40, 10, 5], [-20, -5, 0]);
  const posts = [-15, 15].map((x) => TriMesh.box([10, 10, 21], [x - 5, -5, 4])); // overlap the slab
  return geometry.union([slab, ...posts]);
}

function assertVolumeConserved(part, seg) {
  approx(seg.segments.reduce((s, g) => s + g.mesh.volume(), 0), part.volume(), part.volume() * 1e-4);
  assert.ok(seg.segments.every((g) => g.mesh.isWatertight()), 'all segments watertight');
}

test('no cuts -> one segment', () => {
  const seg = applyCuts(cube(), [], loadMachine());
  assert.equal(seg.segments.length, 1);
  assert.deepEqual(seg.order, [0]);
  assert.ok(seg.valid);
});

test('arm cut', () => {
  const part = cubeWithArm();
  const seg = applyCuts(part, [new Cut([10, 0, 14], [1, 0, 0])], loadMachine());
  assert.ok(seg.valid, seg.warnings.join('; '));
  assert.equal(seg.segments.length, 2);
  assert.deepEqual(seg.segments[1].supports, [0]);
  assert.deepEqual(seg.order, [0, 1]);
  approx(seg.segments[1].direction, [1, 0, 0]);
  approx(tiltDeg(seg.segments[1].direction), 90, 1e-9);
  approx(overhangArea(seg.segments[1].mesh, seg.segments[1].direction), 0, 1e-6); // no overhang left
  assertVolumeConserved(part, seg);
});

test('T-shape, two cuts', () => {
  const part = tShape();
  const seg = applyCuts(part, [new Cut([5, 0, 34], [1, 0, 0]), new Cut([-5, 0, 34], [-1, 0, 0])], loadMachine());
  assert.ok(seg.valid, seg.warnings.join('; '));
  assert.equal(seg.segments.length, 3);
  assert.deepEqual(seg.segments[1].supports, [0]);
  assert.deepEqual(seg.segments[2].supports, [0]);
  assert.deepEqual(seg.order, [0, 1, 2]);
  assertVolumeConserved(part, seg);
});

test('local cut takes only the nearest piece', () => {
  const part = twoTowers();
  const seg = applyCuts(part, [new Cut([15, 0, 10], [0, 0, 1], { local: true })], loadMachine());
  assert.equal(seg.cutReports[0].pieceCentroids.length, 2); // two posts above the plane
  approx(seg.segments[1].mesh.bounds().min[0], 10, 1e-4); // only the right post (x 10..20)
  assert.equal(geometry.components(seg.segments[0].mesh).length, 1); // left post glued back
  assertVolumeConserved(part, seg);
});

test('local cut with an explicit piece', () => {
  // Pieces are sorted by centroid x: piece 0 is the left post.
  const seg = applyCuts(twoTowers(), [new Cut([15, 0, 10], [0, 0, 1], { local: true, components: [0] })], loadMachine());
  approx(seg.segments[1].mesh.bounds().max[0], -10, 1e-4);
});

test('non-local cut takes all pieces', () => {
  const seg = applyCuts(twoTowers(), [new Cut([15, 0, 10], [0, 0, 1])], loadMachine());
  assert.equal(geometry.components(seg.segments[1].mesh).length, 2);
  assert.ok(seg.valid, seg.warnings.join('; '));
});

test('a cut whose point is in a child segment cuts that child', () => {
  const seg = applyCuts(cubeWithArm(), [new Cut([10, 0, 14], [1, 0, 0]), new Cut([25, 0, 14], [1, 0, 0])], loadMachine());
  assert.equal(seg.cutReports[1].targetSegment, 1);
  assert.deepEqual(seg.segments[2].supports, [1]);
  assert.deepEqual(seg.order, [0, 1, 2]);
});

test('dependencies follow later cuts', () => {
  // Cut the arm off, then cut the cube in half horizontally. The arm
  // (z 10..18) now rests on the UPPER cube half, which must print first.
  const seg = applyCuts(cubeWithArm(), [new Cut([10, 0, 14], [1, 0, 0]), new Cut([0, 0, 10], [0, 0, 1])], loadMachine());
  assert.deepEqual(seg.segments[1].supports, [2]);
  assert.deepEqual(seg.order, [0, 2, 1]);
  assert.ok(seg.valid, seg.warnings.join('; '));
});

test('reordering cuts changes the result', () => {
  const seg = applyCuts(cubeWithArm(), [new Cut([0, 0, 10], [0, 0, 1]), new Cut([10, 0, 14], [1, 0, 0])], loadMachine());
  assert.equal(seg.cutReports[1].targetSegment, 1);
  assert.deepEqual(seg.order, [0, 1, 2]);
});

test('point outside is skipped', () => {
  const seg = applyCuts(cube(), [new Cut([100, 0, 10], [1, 0, 0])], loadMachine());
  assert.equal(seg.cutReports[0].applied, false);
  assert.equal(seg.segments.length, 1);
  assert.ok(seg.warnings.some((w) => w.includes('not inside any segment')));
});

test('plane that does not split is skipped', () => {
  const seg = applyCuts(cube(), [new Cut([10, 0, 10], [1, 0, 0])], loadMachine()); // on the surface, nothing beyond
  assert.equal(seg.cutReports[0].applied, false);
  assert.ok(seg.warnings.some((w) => w.includes('does not split')));
});

test('downward cut warns about mid-air and A limits', () => {
  const text = applyCuts(cube(), [new Cut([0, 0, 10], [0, 0, -1])], loadMachine()).warnings.join(' ');
  assert.ok(text.includes('mid-air'));
  assert.ok(text.includes('outside the A-axis limits'));
});

test('cycle detection', () => {
  const { order, warning } = printOrder([
    { id: 0, supports: [] }, { id: 1, supports: [2] }, { id: 2, supports: [1] },
  ]);
  assert.equal(order[0], 0);
  assert.deepEqual([...order].sort(), [0, 1, 2]);
  assert.match(warning, /loop/);
});
