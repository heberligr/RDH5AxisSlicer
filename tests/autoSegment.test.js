import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initGeometry } from '../src/core/geometry.js';
import { autoSegment, hemisphereDirections } from '../src/core/autoSegment.js';
import { cube, cubeWithArm, tShape } from '../src/core/demoModels.js';
import { placeOnBed } from '../src/core/meshIO.js';
import { overhangArea } from '../src/core/overhang.js';
import { applyCuts, tiltDeg } from '../src/core/segments.js';
import { loadMachine, loadSettings } from './helpers.js';

before(() => initGeometry());
const run = (makePart) => {
  const machine = loadMachine();
  return autoSegment(placeOnBed(makePart(), machine), machine, loadSettings());
};

test('candidate directions: hemisphere, include the axes, respect A limits', () => {
  const dirs = hemisphereDirections(15);
  assert.ok(dirs.every((d) => d[2] >= -1e-9));
  for (const axis of [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1]])
    assert.ok(dirs.some((d) => d.every((x, k) => Math.abs(x - axis[k]) < 1e-9)), `missing ${axis}`);
  const m = loadMachine();
  Object.assign(m.kinematics.a_axis, { min_deg: -30, max_deg: 30 });
  assert.ok(hemisphereDirections(15, m).every((d) => tiltDeg(d) <= 30 + 1e-9));
});

test('plain cube: no cuts', async () => {
  const r = await run(cube);
  assert.equal(r.cuts.length, 0);
  assert.equal(r.remaining.length, 0);
});

test('cube with arm: exactly one extra segment, tilted toward the arm', async () => {
  const r = await run(cubeWithArm);
  assert.equal(r.cuts.length, 1);
  assert.equal(r.segmentation.segments.length, 2);
  assert.ok(r.segmentation.valid, r.segmentation.warnings.join('; '));
  const d = r.cuts[0].normal;
  assert.ok(d[0] > 0.5 && Math.abs(d[1]) < 1e-9, `tilted toward +X, got ${d}`);
  assert.equal(r.remaining.length, 0);
  // The new segment really has no overhang left.
  const s = r.segmentation.segments[1];
  assert.equal(overhangArea(s.mesh, s.direction), 0);
});

test('T-shape: two cuts, one toward each side', async () => {
  const r = await run(tShape);
  assert.equal(r.cuts.length, 2);
  assert.equal(r.segmentation.segments.length, 3);
  assert.ok(r.segmentation.valid, r.segmentation.warnings.join('; '));
  const xs = r.cuts.map((c) => Math.sign(c.normal[0])).sort();
  assert.deepEqual(xs, [-1, 1]);
});

test('the auto cuts re-apply identically in the editor', async () => {
  const machine = loadMachine();
  const part = placeOnBed(tShape(), machine);
  const r = await autoSegment(part, machine, loadSettings());
  const again = applyCuts(part, r.cuts, machine);
  assert.deepEqual(again.order, r.segmentation.order);
  assert.ok(again.valid);
});

test('every decision is logged', async () => {
  const r = await run(tShape);
  assert.equal(r.log.length, 2);
  for (const entry of r.log) {
    assert.ok(entry.region.area > 0);
    assert.ok(entry.candidatesTried > 10);
    assert.ok(entry.best.length > 0);
    assert.match(entry.decision, /cut along/);
  }
  // The second cut had to avoid the first segment: its log shows the collision.
  assert.ok(r.log[1].best.some((b) => b.collision === 'segment 1'));
});

test('a region with no allowed direction is reported, not cut', async () => {
  const machine = loadMachine();
  Object.assign(machine.kinematics.a_axis, { min_deg: -10, max_deg: 10 }); // barely tilts
  const r = await autoSegment(placeOnBed(cubeWithArm(), machine), machine, loadSettings());
  assert.equal(r.cuts.length, 0);
  assert.equal(r.remaining.length, 1);
  assert.match(r.remaining[0].message, /needs supports or manual cut/);
});

test('tilt weight: a huge tilt penalty means it prefers to leave the overhang', async () => {
  const machine = loadMachine();
  const settings = loadSettings();
  settings.auto_segment.weight_tilt = 10; // 45 deg would cost 450 > 200 mm^2 of overhang
  const r = await autoSegment(placeOnBed(cubeWithArm(), machine), machine, settings);
  assert.equal(r.cuts.length, 0);
  assert.match(r.log[0].decision, /no cut beats leaving it/);
});
