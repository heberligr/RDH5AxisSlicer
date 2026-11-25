import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HotendModel, ObstacleSet, checkCollision, checkMany, sampleSurfaceGrid, tableMesh } from '../src/core/collision.js';
import { TriMesh } from '../src/core/mesh.js';
import { directionFromAngles } from '../src/core/transforms.js';
import { approx, loadMachine } from './helpers.js';

const UP = [0, 0, 1];
// Cone 45 deg, 10 mm tall -> 10 mm radius at top; cylinder r=20 from z=10 to 40.
const hotend = () => new HotendModel({
  cone_half_angle_deg: 45, cone_height: 10, cylinder_radius: 20, cylinder_start: 10,
  cylinder_height: 30, clearance: 0, tip_ignore_height: 0.3,
});
const box = (size, center) => TriMesh.centeredBox(size, center);
const obstacles = (meshes, spacing = 0.5, names = null) => ObstacleSet.fromMeshes(meshes, spacing, names);

test('radius profile', () => {
  const h = hotend();
  approx([0, 5, 10, 25, 40, 41].map((z) => h.radiusAt(z)), [0, 5, 20, 20, 20, 0], 1e-9);
});

test('mesh matches size and follows direction', () => {
  const { min, max } = hotend().toMesh([0, 0, 0], UP).bounds();
  approx(min, [-20, -20, 0], 1e-6);
  approx(max, [20, 20, 40], 1e-6);
  const side = hotend().toMesh([5, 5, 5], [1, 0, 0]).bounds();
  approx(side.min[0], 5, 1e-6); // tip end
  approx(side.max[0], 45, 1e-6); // top of the cylinder
});

test('sampling covers the surface', () => {
  const pts = sampleSurfaceGrid(box([10, 10, 10], [0, 0, 0]), 1);
  // Every sample is on the surface (some coordinate is at +-5).
  for (let i = 0; i < pts.length; i += 3)
    approx(Math.max(Math.abs(pts[i]), Math.abs(pts[i + 1]), Math.abs(pts[i + 2])), 5, 1e-9);
  // Every point of a fine grid on the top face is within ~1 spacing of a sample.
  const top = [];
  for (let i = 0; i < pts.length; i += 3) if (Math.abs(pts[i + 2] - 5) < 1e-9) top.push([pts[i], pts[i + 1]]);
  let worst = 0;
  for (let x = -5; x <= 5; x += 0.25)
    for (let y = -5; y <= 5; y += 0.25)
      worst = Math.max(worst, Math.min(...top.map(([a, b]) => Math.hypot(a - x, b - y))));
  assert.ok(worst <= 1, `worst gap ${worst}`);
});

test('tip resting on a box is not a collision', () => {
  assert.equal(checkCollision(hotend(), [0, 0, 10.2], UP, obstacles([box([20, 20, 10], [0, 0, 5])])).hit, false);
});

test('wall beside the hotend: hit when near, clear when far', () => {
  assert.equal(checkCollision(hotend(), [0, 0, 0], UP, obstacles([box([3, 40, 60], [13.5, 0, 30])])).hit, true);
  assert.equal(checkCollision(hotend(), [0, 0, 0], UP, obstacles([box([3, 40, 60], [25, 0, 30])])).hit, false);
});

test('short obstacle only hits the cone when close', () => {
  const lowBlockAt = (x) => obstacles([box([2, 10, 4], [x + 1, 0, 2])]); // block spans x..x+2, z 0..4
  assert.equal(checkCollision(hotend(), [0, 0, 0], UP, lowBlockAt(2)).hit, true);
  assert.equal(checkCollision(hotend(), [0, 0, 0], UP, lowBlockAt(6)).hit, false);
});

test('tilting toward a flat block causes a hit', () => {
  const obs = obstacles([box([60, 60, 10], [0, 0, -5])], 1);
  const tip = [0, 0, 0.5];
  assert.equal(checkCollision(hotend(), tip, UP, obs).hit, false);
  assert.equal(checkCollision(hotend(), tip, directionFromAngles(60, 0), obs).hit, true);
  // 30 deg: the cone clears, but the wide cylinder's low edge dips to
  // z = 0.5 + 10 cos30 - 20 sin30 = -0.84 -> still a hit.
  assert.equal(checkCollision(hotend(), tip, directionFromAngles(30, 0), obs).hit, true);
  // 20 deg: lowest cylinder edge at 0.5 + 10 cos20 - 20 sin20 = +3.06 -> clear.
  assert.equal(checkCollision(hotend(), tip, directionFromAngles(20, 0), obs).hit, false);
});

test('far obstacle is skipped; reports which obstacle', () => {
  assert.equal(checkCollision(hotend(), [0, 0, 0], UP, obstacles([box([5, 5, 5], [500, 500, 500])])).hit, false);
  const res = checkCollision(hotend(), [0, 0, 0], UP,
    obstacles([box([5, 5, 5], [300, 0, 0]), box([5, 5, 50], [8, 0, 25])], 0.5, ['far', 'near']));
  assert.equal(res.hit, true);
  assert.equal(res.obstacleName, 'near');
});

test('checkMany finds the first hit', () => {
  const obs = obstacles([box([3, 40, 60], [13.5, 0, 30])]);
  const hits = checkMany(hotend(), [[-60, 0, 0], [-40, 0, 0], [0, 0, 0], [5, 0, 0]], UP, obs);
  assert.deepEqual(hits.map((h) => h.index), [2]);
});

test('clearance makes it more conservative', () => {
  const obs = obstacles([box([3, 40, 60], [22.5, 0, 30])]); // wall face at x = 21
  const h = hotend();
  assert.equal(checkCollision(h, [0, 0, 0], UP, obs).hit, false);
  h.clearance = 1;
  assert.equal(checkCollision(h, [0, 0, 0], UP, obs).hit, true);
});

test('table top is at surface_z', () => {
  const m = loadMachine();
  approx(tableMesh(m.table).bounds().max[2], m.table.surface_z, 1e-9);
});
