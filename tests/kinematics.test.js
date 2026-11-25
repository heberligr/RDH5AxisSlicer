import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IKError, fromCommanded, inverseKinematics, machineToPart, outsideLinearLimits, partToMachine,
  tableRotation, toCommanded, toolDirectionInPart,
} from '../src/core/kinematics.js';
import { directionFromAngles } from '../src/core/transforms.js';
import { matVec, normalize } from '../src/core/vec.js';
import { approx, loadMachine } from './helpers.js';

/** The key IK property: after rotating the table, d points along machine +Z. */
const assertPointsUp = (d, pose) => approx(matVec(tableRotation(pose.a, pose.c), normalize(d)), [0, 0, 1], 1e-9);

test('vertical gives zero tilt', () => {
  const pose = inverseKinematics([0, 0, 1], loadMachine());
  approx([pose.a, pose.c], [0, 0]);
});

test('vertical keeps previous C', () => {
  const pose = inverseKinematics([0, 0, 1], loadMachine(), { a: 30, c: 123 });
  approx([pose.a, pose.c], [0, 123]);
});

for (const az of [0, 45, 90, 135, 180, -135, -90, -45]) {
  test(`45 deg tilt toward azimuth ${az}`, () => {
    const d = directionFromAngles(45, az);
    const pose = inverseKinematics(d, loadMachine());
    approx(Math.abs(pose.a), 45);
    assertPointsUp(d, pose);
    approx(toolDirectionInPart(pose), d, 1e-9);
  });
}

test('known angles: tilt toward +X -> A45 C90', () => {
  // C=90 turns d toward +Y, then A=+45 brings it up. (The mirror solution
  // A=-45 C=-90 is just as far from C=0; ties go to the first.)
  const pose = inverseKinematics([1, 0, 1], loadMachine());
  approx([pose.a, pose.c], [45, 90]);
});

test('known angles: tilt toward -Y -> A-45 C0', () => {
  const pose = inverseKinematics([0, -1, 1], loadMachine());
  approx([pose.a, pose.c], [-45, 0]);
});

test('IK property holds over a range', () => {
  const m = loadMachine();
  for (const tilt of [10, 60, 89, 90])
    for (const az of [-170, -30, 0, 75, 160]) {
      const d = directionFromAngles(tilt, az);
      assertPointsUp(d, inverseKinematics(d, m));
    }
});

test('unreachable direction throws', () => {
  const m = loadMachine();
  assert.throws(() => inverseKinematics(directionFromAngles(120, 0), m), IKError);
  assert.throws(() => inverseKinematics([0, 0, -1], m), IKError);
});

test('tight A limit rejects big tilt', () => {
  const m = loadMachine();
  m.kinematics.a_axis.min_deg = -30;
  m.kinematics.a_axis.max_deg = 30;
  assert.throws(() => inverseKinematics(directionFromAngles(45, 0), m), IKError);
  inverseKinematics(directionFromAngles(25, 0), m);
});

test('one-sided A limit picks the mirror solution', () => {
  const m = loadMachine();
  m.kinematics.a_axis.min_deg = 0;
  for (const az of [0, 90, 180, -90]) {
    const d = directionFromAngles(40, az);
    const pose = inverseKinematics(d, m);
    assert.ok(pose.a > 0);
    assertPointsUp(d, pose);
  }
});

test('C continuity avoids full turns', () => {
  const d = directionFromAngles(30, 10);
  const pose = inverseKinematics(d, loadMachine(), { a: 0, c: 720 });
  assert.ok(Math.abs(pose.c - 720) <= 180);
  assertPointsUp(d, pose);
});

test('limited C stays in range', () => {
  const m = loadMachine();
  Object.assign(m.kinematics.c_axis, { continuous: false, min_deg: -180, max_deg: 180 });
  for (let az = -180; az <= 180; az += 30) {
    const d = directionFromAngles(50, az);
    const pose = inverseKinematics(d, m, { a: 0, c: 170 });
    assert.ok(pose.c >= -180 - 1e-9 && pose.c <= 180 + 1e-9);
    assertPointsUp(d, pose);
  }
});

test('signs flip commanded angles', () => {
  const m = loadMachine();
  m.kinematics.a_axis.sign = -1;
  const cmd = toCommanded({ a: 30, c: 45 }, m);
  assert.deepEqual(cmd, { a: -30, c: 45 });
  assert.deepEqual(fromCommanded(cmd.a, cmd.c, m), { a: 30, c: 45 });
});

test('sign affects the limit check', () => {
  const m = loadMachine();
  Object.assign(m.kinematics.a_axis, { sign: -1, min_deg: -90, max_deg: 0 });
  const pose = inverseKinematics(directionFromAngles(45, 0), m);
  assert.ok(pose.a > 0);
  assert.ok(toCommanded(pose, m).a < 0);
});

// ---------------------------- pivot handling ---------------------------- //
const PIVOT = [12, -5, 40];

test('pivot point does not move', () => {
  approx(partToMachine(PIVOT, { a: 37, c: -122 }, PIVOT), PIVOT, 1e-9);
});

test('point along build direction ends up above pivot', () => {
  const d = directionFromAngles(45, 30);
  const pose = inverseKinematics(d, loadMachine());
  const p = PIVOT.map((x, i) => x + 25 * d[i]);
  approx(partToMachine(p, pose, PIVOT), [PIVOT[0], PIVOT[1], PIVOT[2] + 25], 1e-9);
});

test('zero pose is identity', () => {
  approx(partToMachine([1, 2, 3], { a: 0, c: 0 }, PIVOT), [1, 2, 3], 1e-12);
});

test('pure C rotation is about the pivot, not the origin', () => {
  approx(partToMachine([PIVOT[0] + 1, PIVOT[1], PIVOT[2]], { a: 0, c: 90 }, PIVOT), [PIVOT[0], PIVOT[1] + 1, PIVOT[2]], 1e-9);
});

test('part <-> machine round trip', () => {
  const pose = { a: -63, c: 211 };
  for (const p of [[10, 20, 30], [-80, 5, 66], [0, 0, 0]])
    approx(machineToPart(partToMachine(p, pose, PIVOT), pose, PIVOT), p, 1e-9);
});

test('linear limit check', () => {
  const m = loadMachine();
  assert.equal(outsideLinearLimits([0, 0, 10], m), false);
  assert.equal(outsideLinearLimits([500, 0, 10], m), true);
  assert.equal(outsideLinearLimits([0, 0, -1], m), true);
});
