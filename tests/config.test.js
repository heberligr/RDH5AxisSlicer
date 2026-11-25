import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load as loadYaml } from 'js-yaml';
import { ConfigError, machineFromObject } from '../src/core/config.js';
import { MACHINE_YAML, loadMachine } from './helpers.js';

const raw = () => loadYaml(MACHINE_YAML);

test('default machine loads', () => {
  const m = loadMachine();
  assert.equal(m.kinematics.a_axis.letter, 'A');
  assert.equal(m.kinematics.c_axis.letter, 'C');
  assert.equal(m.kinematics.pivot.length, 3);
  assert.ok(m.hotend.cone_height > 0);
  assert.ok(m.start_gcode.includes('G28'));
});

test('missing value names the key', () => {
  const r = raw();
  delete r.hotend.cone_height;
  assert.throws(() => machineFromObject(r), (e) => e instanceof ConfigError && /hotend\.cone_height/.test(e.message));
});

test('bad sign rejected', () => {
  const r = raw();
  r.kinematics.a_axis.sign = 2;
  assert.throws(() => machineFromObject(r), /sign/);
});

test('bad firmware rejected', () => {
  const r = raw();
  r.firmware = 'grbl';
  assert.throws(() => machineFromObject(r), /firmware/);
});
