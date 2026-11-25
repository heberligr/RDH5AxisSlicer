import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initGeometry } from '../src/core/geometry.js';
import { cube, cubeWithArm } from '../src/core/demoModels.js';
import { overhangArea, overhangMask } from '../src/core/overhang.js';
import { TriMesh } from '../src/core/mesh.js';
import { rotY } from '../src/core/transforms.js';
import { dot } from '../src/core/vec.js';
import { approx } from './helpers.js';

before(() => initGeometry());
const UP = [0, 0, 1];

test('cube has no overhang (bottom face is on the bed)', () => {
  assert.equal(overhangArea(cube(), UP), 0);
});

test('arm underside is an overhang', () => {
  approx(overhangArea(cubeWithArm(), UP), 25 * 8, 1e-3); // 25 mm of arm outside the cube x 8 mm wide
});

test('printing sideways (+X), only -X facing faces count', () => {
  const m = cubeWithArm();
  overhangMask(m, [1, 0, 0]).forEach((isOver, f) => {
    if (isOver) approx(dot(m.faceNormal(f), [-1, 0, 0]), 1, 1e-6);
  });
});

test('threshold', () => {
  // Box resting on an edge: its two bottom faces lean 45 deg from vertical.
  const b = TriMesh.centeredBox([10, 10, 10]).transformed(rotY(45));
  const count = (t) => overhangMask(b, UP, t).filter(Boolean).length;
  assert.equal(count(50), 0); // 45 < 50: printable
  assert.equal(count(40), 4); // 45 > 40: 2 faces x 2 triangles
});
