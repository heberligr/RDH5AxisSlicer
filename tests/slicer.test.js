import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../src/core/geometry.js';
import { cube, cubeWithArm } from '../src/core/demoModels.js';
import { placeOnBed } from '../src/core/meshIO.js';
import { Cut, applyCuts } from '../src/core/segments.js';
import { hatch, sliceAll, sliceSegment, toPartFrame } from '../src/core/slicer.js';
import { approx, loadMachine, loadSettings } from './helpers.js';

before(() => geometry.initGeometry());

test('hatch fills a square with evenly spaced lines', () => {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const lines = hatch(square, 1, 0);
  assert.equal(lines.length, 10); // y = 0..9 (y=10 is the top edge)
  for (const [p, q] of lines) approx(Math.abs(q[0] - p[0]), 10, 1e-9);
  // A hole is skipped (even-odd rule).
  const withHole = [square[0], [[4, 4], [6, 4], [6, 6], [4, 6]]];
  assert.ok(hatch(withHole, 1, 0).length > lines.length);
});

test('plain cube: layer count, walls and solid top/bottom', () => {
  const machine = loadMachine(), settings = loadSettings();
  const seg = applyCuts(placeOnBed(cube(), machine), [], machine).segments[0];
  const sl = sliceSegment(seg, { a: 0, c: 0 }, settings);
  assert.equal(sl.layers.length, 100); // 20 mm / 0.2 mm
  const kinds = (i) => new Set(sl.layers[i].paths.map((p) => p.kind));
  assert.deepEqual([...kinds(0)].sort(), ['infill', 'inner', 'outer', 'solid'].filter((k) => kinds(0).has(k)).sort());
  assert.ok(kinds(0).has('solid') && !kinds(0).has('infill'), 'bottom layer is solid');
  assert.ok(kinds(50).has('infill') && !kinds(50).has('solid'), 'middle layer is sparse');
  assert.ok(kinds(99).has('solid'), 'top layer is solid');
  // Outer wall sits half a line width inside the 20 mm square.
  const outer = sl.layers[50].paths.find((p) => p.kind === 'outer').points;
  const xs = outer.map((p) => p[0]);
  approx(Math.max(...xs) - Math.min(...xs), 20 - settings.slicing.line_width, 1e-6);
});

test('toolpaths line up with the segment mesh (tilted segment)', () => {
  // The "detect the slicer's offset" check from the spec: every extrusion
  // point, mapped back to the part frame, must lie on/in its segment.
  const machine = loadMachine(), settings = loadSettings();
  const part = placeOnBed(cubeWithArm(), machine);
  const seg = applyCuts(part, [new Cut([-2.5, -4, 10], [Math.SQRT1_2, 0, Math.SQRT1_2], { local: true, components: [0] })], machine);
  assert.ok(seg.valid, seg.warnings.join('; '));
  const sliced = sliceSegment(seg.segments[1], { a: 45, c: 90 }, settings);
  const mesh = seg.segments[1].mesh;
  const w = settings.slicing.line_width;
  let checked = 0;
  for (const L of sliced.layers)
    for (const p of L.paths)
      for (const [x, y] of p.points.filter((_, i) => i % 3 === 0)) {
        const q = toPartFrame(sliced, x, y, L.z - settings.slicing.layer_height / 2); // middle of the bead
        assert.ok(geometry.contains(mesh, q) || geometry.distanceToSurface(mesh, q) <= w, `point ${q} is off the part`);
        checked++;
      }
  assert.ok(checked > 200);
});

test('first layer of a child segment sits on its cut plane', () => {
  const machine = loadMachine(), settings = loadSettings();
  const part = placeOnBed(cubeWithArm(), machine);
  const seg = applyCuts(part, [new Cut([-2.5, 0, 14], [1, 0, 0])], machine);
  const armSl = sliceSegment(seg.segments[1], { a: 90, c: 90 }, settings);
  const p = armSl.layers[0].paths[0].points[0];
  const q = toPartFrame(armSl, p[0], p[1], armSl.layers[0].z);
  approx(q[0], -2.5 + settings.slicing.layer_height, 1e-6); // one layer above the cut at x = -2.5
});

test('sliceAll keeps C continuous between segments', async () => {
  const machine = loadMachine(), settings = loadSettings();
  const part = placeOnBed(cubeWithArm(), machine);
  const seg = applyCuts(part, [new Cut([-2.5, 0, 14], [1, 0, 0])], machine);
  const all = await sliceAll(seg, machine, settings);
  assert.deepEqual(all.map((s) => s.segmentId), seg.order);
  assert.deepEqual(all[1].pose, { a: 90, c: 90 });
});
