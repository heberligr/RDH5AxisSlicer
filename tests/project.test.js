import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initGeometry } from '../src/core/geometry.js';
import { TriMesh } from '../src/core/mesh.js';
import { exportSTL } from '../src/core/meshIO.js';
import { Project } from '../src/core/project.js';
import { Cut } from '../src/core/segments.js';
import { approx, loadMachine } from './helpers.js';

before(() => initGeometry());

test('round trip with an embedded STL', () => {
  const p = new Project({
    stlName: 'box.stl',
    stlBuffer: exportSTL(TriMesh.box([10, 10, 10])),
    baseRotation: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    cuts: [new Cut([1, 2, 3], [0, 0, 2], { local: true, components: [1], name: 'arm' })],
  });
  const back = Project.parse(p.serialize());
  assert.equal(back.stlName, 'box.stl');
  back.overhangAngleDeg = 45;
  assert.equal(back.settings.overhang.threshold_deg, 45);
  assert.deepEqual(back.baseRotation, [[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
  const c = back.cuts[0];
  approx(c.point, [1, 2, 3]);
  approx(c.normal, [0, 0, 1]); // normalised
  assert.ok(c.local && c.components[0] === 1 && c.name === 'arm');
  const part = back.loadPart(loadMachine());
  approx(part.volume(), 1000, 1e-3);
  approx(part.bounds().min[2], loadMachine().table.surface_z, 1e-9);
});

test('round trip with a demo part', () => {
  const back = Project.parse(new Project({ demoName: 'T-shape' }).serialize());
  assert.equal(back.demoName, 'T-shape');
  assert.equal(back.loadPart(loadMachine()).isWatertight(), true);
});

test('bad project files give clear errors', () => {
  assert.throws(() => Project.parse('{"version": 2, "model": {}}'), /no model/);
  assert.throws(() => Project.parse('{"version": 99, "model": {"demo": "Cube"}}'), /newer version/);
});

test('old project files (overhang_angle_deg only) still load', () => {
  const back = Project.parse('{"version": 2, "model": {"demo": "Cube"}, "overhang_angle_deg": 40}');
  assert.equal(back.settings.overhang.threshold_deg, 40);
  assert.equal(back.settings.slicing.layer_height, 0.2);
});
