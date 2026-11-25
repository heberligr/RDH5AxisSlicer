// Regenerate examples/*.json by running auto-segmentation on the demo parts.
//   node tools/make-examples.mjs
import { writeFileSync } from 'node:fs';
import { initGeometry } from '../src/core/geometry.js';
import { autoSegment } from '../src/core/autoSegment.js';
import { Project } from '../src/core/project.js';
import { loadMachine, loadSettings } from '../tests/helpers.js';

await initGeometry();
const machine = loadMachine();
for (const [demoName, file] of [['Cube', 'cube'], ['Cube with arm', 'cube_with_arm'], ['T-shape', 't_shape']]) {
  const project = new Project({ demoName, settings: loadSettings() });
  const result = await autoSegment(project.loadPart(machine), machine, project.settings);
  project.cuts = result.cuts;
  writeFileSync(new URL(`../examples/${file}.json`, import.meta.url), project.serialize() + '\n');
  console.log(`${file}.json: ${result.cuts.length} cut(s), ${result.segmentation.segments.length} segment(s)`);
}
