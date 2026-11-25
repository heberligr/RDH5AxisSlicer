import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initGeometry } from '../src/core/geometry.js';
import { cube, cubeWithArm, tShape } from '../src/core/demoModels.js';
import { chooseOrientation, contactArea, fibonacciSphere } from '../src/core/orientation.js';
import { overhangArea } from '../src/core/overhang.js';
import { rotY } from '../src/core/transforms.js';
import { approx, loadSettings } from './helpers.js';

before(() => initGeometry());

test('fibonacci sphere gives unit vectors', () => {
  for (const v of fibonacciSphere(20)) approx(Math.hypot(...v), 1, 1e-12);
});

test('cube stays as it is', () => {
  const r = chooseOrientation(cube(), loadSettings());
  approx(r.up, [0, 0, 1], 1e-9);
  assert.equal(r.overhang, 0);
  approx(r.contact, 400, 1e-6);
});

test('cube with arm: standing on its end removes the overhang', () => {
  const part = cubeWithArm();
  const r = chooseOrientation(part, loadSettings());
  assert.equal(r.current.overhang, 200);
  assert.equal(r.overhang, 0);
  assert.equal(overhangArea(part.transformed(r.rotation), [0, 0, 1]), 0);
});

test('a tipped-over cube is put back flat', () => {
  const tipped = cube().transformed(rotY(30));
  const r = chooseOrientation(tipped, loadSettings());
  approx(contactArea(tipped.transformed(r.rotation), [0, 0, 1]), 400, 1e-3);
});

test('T-shape upside down beats the T standing (no overhang)', () => {
  const r = chooseOrientation(tShape(), loadSettings());
  assert.equal(r.current.overhang, 400);
  assert.equal(r.overhang, 0);
});
