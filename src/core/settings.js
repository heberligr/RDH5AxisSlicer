/**
 * Slicer settings (config/settings.yaml): defaults, loading and checking.
 *
 * Any value missing from the YAML (or from an older project file) falls back
 * to DEFAULT_SETTINGS below, so adding a new setting never breaks old files.
 */

import { load as loadYaml } from 'js-yaml';
import { ConfigError } from './config.js';

export const DEFAULT_SETTINGS = {
  overhang: { threshold_deg: 50, min_region_area: 20 },
  auto_segment: {
    candidate_step_deg: 15, max_depth: 3, cut_margin: 0.0,
    weight_parent_overhang: 1.0, weight_tilt: 0.5, max_cuts: 12,
  },
  orientation: { sphere_samples: 64, min_contact_area: 25 },
  slicing: {
    layer_height: 0.2, line_width: 0.45, perimeters: 2, top_bottom_layers: 3,
    infill_density: 0.2, infill_angle_deg: 45, filament_diameter: 1.75,
    print_speed: 40, first_layer_speed: 20, travel_speed: 120, retract_min_travel: 2.0,
  },
  collision_check: { points_per_layer: 6, rotation_steps: 12 },
};

/**
 * Merge `raw` (possibly partial) onto the defaults and check every value is a
 * number. Unknown keys are an error, to catch typos.
 */
export function settingsFromObject(raw = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const [section, values] of Object.entries(raw ?? {})) {
    if (!(section in out)) throw new ConfigError(`Unknown settings section '${section}'`);
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!(key in out[section])) throw new ConfigError(`Unknown setting '${section}.${key}'`);
      const v = Number(value);
      if (!Number.isFinite(v)) throw new ConfigError(`Setting '${section}.${key}' must be a number`);
      out[section][key] = v;
    }
  }
  const s = out.slicing;
  if (s.layer_height <= 0 || s.line_width <= 0) throw new ConfigError('slicing.layer_height and line_width must be > 0');
  if (s.infill_density < 0 || s.infill_density > 1) throw new ConfigError('slicing.infill_density must be between 0 and 1');
  if (out.auto_segment.candidate_step_deg < 1) throw new ConfigError('auto_segment.candidate_step_deg must be >= 1');
  return out;
}

export function parseSettingsYaml(text) {
  let raw;
  try {
    raw = loadYaml(text);
  } catch (err) {
    throw new ConfigError(`settings.yaml is not valid YAML: ${err.message}`);
  }
  return settingsFromObject(raw);
}
