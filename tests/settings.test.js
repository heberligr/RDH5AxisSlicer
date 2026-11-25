import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, settingsFromObject } from '../src/core/settings.js';
import { loadSettings } from './helpers.js';

test('settings.yaml matches the built-in defaults', () => {
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('missing values fall back to defaults', () => {
  const s = settingsFromObject({ slicing: { layer_height: 0.3 } });
  assert.equal(s.slicing.layer_height, 0.3);
  assert.equal(s.slicing.line_width, DEFAULT_SETTINGS.slicing.line_width);
});

test('typos and bad values are rejected', () => {
  assert.throws(() => settingsFromObject({ slicing: { layer_hieght: 0.3 } }), /slicing\.layer_hieght/);
  assert.throws(() => settingsFromObject({ slicing: { infill_density: 2 } }), /infill_density/);
  assert.throws(() => settingsFromObject({ nonsense: {} }), /nonsense/);
});
