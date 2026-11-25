// Milestone 7: the whole pipeline (auto-segment -> slice -> G-code -> collision
// check) on the three test parts, plus G-code rules from milestone 5.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initGeometry } from '../src/core/geometry.js';
import { autoSegment } from '../src/core/autoSegment.js';
import { checkPlan } from '../src/core/checks.js';
import { DEMO_MODELS } from '../src/core/demoModels.js';
import { GcodeLimitError, generateGcode } from '../src/core/gcode.js';
import { placeOnBed } from '../src/core/meshIO.js';
import { Cut, applyCuts } from '../src/core/segments.js';
import { sliceAll } from '../src/core/slicer.js';
import { loadMachine, loadSettings } from './helpers.js';

before(() => initGeometry());

async function pipeline(name, machine = loadMachine(), settings = loadSettings()) {
  const part = placeOnBed(DEMO_MODELS[name](), machine);
  const auto = await autoSegment(part, machine, settings);
  const sliced = await sliceAll(auto.segmentation, machine, settings);
  const gcode = generateGcode(sliced, machine, settings);
  const check = await checkPlan({ segmentation: auto.segmentation, sliced }, machine, settings);
  return { auto, sliced, gcode, check };
}

for (const [name, expectedSegments] of [['Cube', 1], ['Cube with arm', 2], ['T-shape', 3]]) {
  test(`full pipeline: ${name} -> ${expectedSegments} segment(s), clean G-code, no collisions`, async () => {
    const { auto, gcode, check } = await pipeline(name);
    assert.equal(auto.segmentation.segments.length, expectedSegments);
    assert.ok(auto.segmentation.valid, auto.segmentation.warnings.join('; '));
    assert.equal(auto.remaining.length, 0);
    assert.ok(check.ok, check.issues.map((i) => i.message).join('; '));
    assert.equal(gcode.stats.rotations, expectedSegments);
    assert.ok(gcode.stats.filamentMm > 100);
  });
}

test('printing moves never contain A or C; rotations only between segments', async () => {
  const { gcode } = await pipeline('T-shape');
  const lines = gcode.text.split('\n');
  for (const line of lines.filter((l) => /^G1 .*E/.test(l))) assert.doesNotMatch(line, /\b[AC]-?\d/, line);
  // (The start/end blocks also level the table with G0 A0 C0; we only
  // count the slicer's own rotations, which are marked "; rotate table".)
  const rotations = lines.filter((l) => l.endsWith('; rotate table'));
  assert.equal(rotations.length, 3);
  // Each rotation happens at safe Z, after a retraction.
  for (const r of rotations) {
    const i = lines.indexOf(r);
    assert.match(lines.slice(0, i).reverse().find((l) => l.startsWith('G0 X')), /Z150\.000/);
    assert.ok(lines.slice(Math.max(0, i - 6), i).some((l) => /^G1 E-/.test(l)), 'retract before rotating');
  }
});

test('extrusion is relative (M83) and sums to the reported filament', async () => {
  const { gcode } = await pipeline('Cube with arm');
  const lines = gcode.text.split('\n');
  assert.ok(lines.includes('M83 ; relative extrusion'));
  const body = lines.slice(lines.findIndex((l) => l.startsWith(';LAYER'))); // skip the prime line in the start block
  const total = body.filter((l) => /^G1 X.* E/.test(l)).reduce((s, l) => s + Number(l.match(/E(-?[\d.]+)/)[1]), 0);
  assert.ok(Math.abs(total - gcode.stats.filamentMm) < 0.5);
});

test('points outside the travel limits fail with a clear error', async () => {
  const machine = loadMachine();
  machine.limits.x = [-15, 15]; // the part is 45 mm long
  await assert.rejects(pipeline('Cube with arm', machine), (err) =>
    err instanceof GcodeLimitError && /outside the limits/.test(err.message) && /segment \d+ layer \d+/.test(err.message));
});

test('collision check finds a hotend that is too fat', async () => {
  const machine = loadMachine();
  const settings = loadSettings();
  const part = placeOnBed(DEMO_MODELS['Cube with arm'](), machine);
  // Print the arm sideways (90 deg) - fine for a slim hotend, but a 30 mm
  // radius heater block reaches down into the table.
  const seg = applyCuts(part, [new Cut([-2.5, 0, 14], [1, 0, 0])], machine);
  machine.hotend.cylinder_radius = 30;
  const sliced = await sliceAll(seg, machine, settings);
  const check = await checkPlan({ segmentation: seg, sliced }, machine, settings);
  assert.equal(check.ok, false);
  const issue = check.issues.find((i) => i.kind === 'print');
  assert.equal(issue.segmentId, 1);
  assert.equal(issue.layer, 0);
  assert.match(issue.message, /table/);
});

test('rotation check: safe Z too low is reported', async () => {
  const machine = loadMachine();
  const settings = loadSettings();
  machine.motion.safe_z = 20; // the T is 38 mm tall
  const part = placeOnBed(DEMO_MODELS['T-shape'](), machine);
  const auto = await autoSegment(part, machine, settings);
  const sliced = await sliceAll(auto.segmentation, machine, settings);
  const check = await checkPlan({ segmentation: auto.segmentation, sliced }, machine, settings);
  assert.ok(check.issues.some((i) => i.kind === 'rotation' && /Raise motion\.safe_z/.test(i.message)));
});
