import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Z_AXIS, anglesOf, directionFromAngles, rotatePoint, rotationBetween, rotationFromZ, rotationToZ,
} from '../src/core/transforms.js';
import { det, matMul, matVec, normalize, transpose, identity } from '../src/core/vec.js';
import { approx } from './helpers.js';

// A spread of directions including the awkward ones (+Z, -Z, horizontal).
const DIRECTIONS = [
  [0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0], [1, 1, 1], [-0.3, 0.2, -0.9],
  directionFromAngles(45, 135), directionFromAngles(89.9, -60),
];

for (const d of DIRECTIONS) {
  test(`rotationToZ sends ${d.map((x) => x.toFixed(2))} to +Z, is a proper rotation, round-trips`, () => {
    const R = rotationToZ(d);
    approx(matVec(R, normalize(d)), Z_AXIS, 1e-9);
    approx(matMul(R, transpose(R)).flat(), identity().flat(), 1e-9); // orthonormal
    approx(det(R), 1, 1e-9); // not a mirror
    const center = [3, -7, 12];
    for (const p of [[10, 20, 30], [-40, 5, 0], [0, 0, 0]]) {
      const back = rotatePoint(rotatePoint(p, R, center), rotationFromZ(d), center);
      approx(back, p, 1e-9);
    }
  });
}

test('rotationBetween arbitrary vectors', () => {
  const u = [1, 2, 3], v = [-2, 0.5, 1];
  approx(matVec(rotationBetween(u, v), normalize(u)), normalize(v), 1e-9);
});

test('directionFromAngles and anglesOf', () => {
  approx(directionFromAngles(0, 77), [0, 0, 1], 1e-12);
  approx(directionFromAngles(90, 90), [0, 1, 0], 1e-12);
  const { tilt, azimuth } = anglesOf(directionFromAngles(30, -120));
  approx(tilt, 30, 1e-9);
  approx(azimuth, -120, 1e-9);
});

test('zero vector cannot be normalised', () => {
  assert.throws(() => normalize([0, 0, 0]));
});
