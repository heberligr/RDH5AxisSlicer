// Shared test helpers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMachineYaml } from '../src/core/config.js';

export const MACHINE_YAML = readFileSync(new URL('../config/machine.yaml', import.meta.url), 'utf8');

/** A fresh copy of the default machine for each test (safe to modify). */
export const loadMachine = () => parseMachineYaml(MACHINE_YAML);

/** assert |a - b| <= tol, for numbers or arrays of numbers. */
export function approx(actual, expected, tol = 1e-9, msg = '') {
  if (Array.isArray(expected) || ArrayBuffer.isView(expected)) {
    assert.equal(actual.length, expected.length, `length mismatch ${msg}`);
    for (let i = 0; i < expected.length; i++) approx(actual[i], expected[i], tol, `${msg}[${i}]`);
    return;
  }
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual} (tol ${tol})`);
}
