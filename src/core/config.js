/**
 * Turn the text of machine.yaml into a validated JavaScript object.
 *
 * The object keeps the same names as the YAML file, so
 * `machine.hotend.cone_height` in code is `hotend: cone_height:` in the file.
 * Missing or bad values throw a ConfigError naming the exact key, so a typo
 * shows up immediately instead of as a strange bug later.
 */

import { load as loadYaml } from 'js-yaml';

export class ConfigError extends Error {}

export const SUPPORTED_FIRMWARE = ['marlin', 'reprapfirmware', 'klipper'];
export const SUPPORTED_KINEMATICS = ['table_tilting_AC'];

// --------------------------------------------------------------------- //
// Helpers that read one value and complain clearly if it's wrong
// --------------------------------------------------------------------- //
function get(obj, key, where) {
  if (obj === null || typeof obj !== 'object' || !(key in obj))
    throw new ConfigError(`Missing config value '${where}.${key}'`);
  return obj[key];
}

function num(obj, key, where) {
  const v = Number(get(obj, key, where));
  if (!Number.isFinite(v)) throw new ConfigError(`'${where}.${key}' must be a number`);
  return v;
}

function range(obj, key, where) {
  const v = get(obj, key, where);
  if (!Array.isArray(v) || v.length !== 2) throw new ConfigError(`'${where}.${key}' must be a [min, max] list`);
  const [lo, hi] = v.map(Number);
  if (lo > hi) throw new ConfigError(`'${where}.${key}': min ${lo} is greater than max ${hi}`);
  return [lo, hi];
}

function rotaryAxis(obj, where) {
  const sign = Number(get(obj, 'sign', where));
  if (sign !== 1 && sign !== -1) throw new ConfigError(`'${where}.sign' must be 1 or -1, got ${sign}`);
  const min_deg = num(obj, 'min_deg', where);
  const max_deg = num(obj, 'max_deg', where);
  if (min_deg > max_deg) throw new ConfigError(`'${where}': min_deg ${min_deg} > max_deg ${max_deg}`);
  return {
    letter: String(get(obj, 'letter', where)).toUpperCase(),
    sign,
    min_deg,
    max_deg,
    continuous: Boolean(obj.continuous ?? false),
  };
}

/**
 * Is a COMMANDED angle (the number written in G-code) allowed on this axis?
 * Always true for a continuous axis.
 */
export function withinLimits(axis, commandedDeg, tol = 1e-6) {
  if (axis.continuous) return true;
  return axis.min_deg - tol <= commandedDeg && commandedDeg <= axis.max_deg + tol;
}

/** Build and validate a machine object from an already-parsed YAML object. */
export function machineFromObject(raw) {
  if (raw === null || typeof raw !== 'object') throw new ConfigError('machine.yaml is empty or not a YAML mapping');

  const firmware = String(get(raw, 'firmware', 'machine')).toLowerCase();
  if (!SUPPORTED_FIRMWARE.includes(firmware))
    throw new ConfigError(`firmware must be one of ${SUPPORTED_FIRMWARE.join(', ')}, got '${firmware}'`);

  const k = get(raw, 'kinematics', 'machine');
  const type = String(get(k, 'type', 'kinematics'));
  if (!SUPPORTED_KINEMATICS.includes(type))
    throw new ConfigError(`kinematics.type must be one of ${SUPPORTED_KINEMATICS.join(', ')}, got '${type}'`);
  const pivot = get(k, 'pivot', 'kinematics');
  if (!Array.isArray(pivot) || pivot.length !== 3 || pivot.some((x) => !Number.isFinite(Number(x))))
    throw new ConfigError('kinematics.pivot must be a list of 3 numbers [x, y, z]');
  const kinematics = {
    type,
    pivot: pivot.map(Number),
    a_axis: rotaryAxis(get(k, 'a_axis', 'kinematics'), 'kinematics.a_axis'),
    c_axis: rotaryAxis(get(k, 'c_axis', 'kinematics'), 'kinematics.c_axis'),
  };
  if (kinematics.a_axis.letter === kinematics.c_axis.letter)
    throw new ConfigError('A and C axes must use different G-code letters');

  const lim = get(raw, 'limits', 'machine');
  const limits = { x: range(lim, 'x', 'limits'), y: range(lim, 'y', 'limits'), z: range(lim, 'z', 'limits') };

  const t = get(raw, 'table', 'machine');
  const table = {
    shape: String(get(t, 'shape', 'table')).toLowerCase(),
    diameter: num(t, 'diameter', 'table'),
    size_x: num(t, 'size_x', 'table'),
    size_y: num(t, 'size_y', 'table'),
    thickness: num(t, 'thickness', 'table'),
    surface_z: num(t, 'surface_z', 'table'),
  };
  if (!['round', 'rect'].includes(table.shape)) throw new ConfigError("table.shape must be 'round' or 'rect'");

  const h = get(raw, 'hotend', 'machine');
  const hotend = {};
  for (const key of ['cone_half_angle_deg', 'cone_height', 'cylinder_radius', 'cylinder_start',
    'cylinder_height', 'clearance', 'tip_ignore_height'])
    hotend[key] = num(h, key, 'hotend');
  if (!(hotend.cone_half_angle_deg > 0 && hotend.cone_half_angle_deg < 90))
    throw new ConfigError('hotend.cone_half_angle_deg must be between 0 and 90');

  const c = get(raw, 'collision', 'machine');
  const collision = { sample_spacing: num(c, 'sample_spacing', 'collision') };
  if (collision.sample_spacing <= 0) throw new ConfigError('collision.sample_spacing must be > 0');

  const m = get(raw, 'motion', 'machine');
  const motion = {};
  for (const key of ['safe_retract_distance', 'safe_z', 'travel_feedrate', 'rotary_feedrate',
    'retract_length', 'retract_feedrate'])
    motion[key] = num(m, key, 'motion');

  return {
    name: String(raw.name ?? 'unnamed machine'),
    firmware,
    kinematics,
    limits,
    table,
    hotend,
    collision,
    motion,
    start_gcode: String(raw.start_gcode ?? ''),
    end_gcode: String(raw.end_gcode ?? ''),
  };
}

/** Parse the text of machine.yaml. */
export function parseMachineYaml(text) {
  let raw;
  try {
    raw = loadYaml(text);
  } catch (err) {
    throw new ConfigError(`machine.yaml is not valid YAML: ${err.message}`);
  }
  return machineFromObject(raw);
}

/** Deep copy (handy in tests that tweak a machine). */
export const cloneMachine = (machine) => structuredClone(machine);
