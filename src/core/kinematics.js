/**
 * Forward / inverse kinematics for a table-tilting A/C machine.
 *
 * Machine layout (kinematics.type = "table_tilting_AC")
 * -----------------------------------------------------
 * The part sits on the C table. The C table is mounted on the A trunnion.
 * So a point on the part is first turned by C (about the table's own Z
 * axis), then the whole C table is tilted by A (about the machine X axis).
 * Both axes pass through the pivot point P (machine coordinates):
 *
 *     machine = R_A(a) * R_C(c) * (p - P) + P            (forward kinematics)
 *     p       = R_C(c)^T * R_A(a)^T * (machine - P) + P  (inverse)
 *
 * where p is a point in the PART frame (= machine frame when a = c = 0).
 *
 * Angle conventions
 * -----------------
 *  - `a`, `c` in this module are MATH angles (right-hand rule).
 *  - The firmware may count the other way. machine.yaml has a `sign` per
 *    axis: commanded = sign * math. Use toCommanded() right before writing
 *    G-code. Axis limits in machine.yaml are in COMMANDED degrees.
 *
 * The inverse-kinematics question: each segment has a build direction d
 * (unit vector, part frame). Which table angles make d point straight up
 * (+Z) in the machine, so the nozzle prints flat layers on that segment?
 */

import { withinLimits } from './config.js';
import { matMul, matVec, normalize, transpose } from './vec.js';
import { rotX, rotZ } from './transforms.js';

export class IKError extends Error {}

/** 3x3 rotation applied to part-frame vectors: R = R_A(a) * R_C(c). */
export const tableRotation = (aDeg, cDeg) => matMul(rotX(aDeg), rotZ(cDeg));

/** Map one part-frame point to machine XYZ for pose {a, c}. */
export function partToMachine(p, pose, pivot) {
  const q = matVec(tableRotation(pose.a, pose.c), [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]]);
  return [q[0] + pivot[0], q[1] + pivot[1], q[2] + pivot[2]];
}

/** Inverse of partToMachine. */
export function machineToPart(m, pose, pivot) {
  const q = matVec(transpose(tableRotation(pose.a, pose.c)), [m[0] - pivot[0], m[1] - pivot[1], m[2] - pivot[2]]);
  return [q[0] + pivot[0], q[1] + pivot[1], q[2] + pivot[2]];
}

/** Which part-frame direction points straight up (+Z machine) at this pose. */
export const toolDirectionInPart = (pose) => matVec(transpose(tableRotation(pose.a, pose.c)), [0, 0, 1]);

/** Math angles -> the numbers written after A and C in G-code. */
export function toCommanded(pose, machine) {
  const k = machine.kinematics;
  return { a: k.a_axis.sign * pose.a, c: k.c_axis.sign * pose.c };
}

/** G-code A/C numbers -> math angles. (sign is +-1, so this is its own inverse.) */
export function fromCommanded(aCmd, cCmd, machine) {
  const k = machine.kinematics;
  return { a: k.a_axis.sign * aCmd, c: k.c_axis.sign * cCmd };
}

/** angle + k*360 that is closest to reference (avoids needless full turns). */
const closestEquivalent = (angle, reference) => angle + 360 * Math.round((reference - angle) / 360);

/**
 * Choose the 360-degree-equivalent of c that is valid and nearest prevC.
 * Returns null if no equivalent is within the C limits.
 */
function pickC(cMath, prevC, machine) {
  const axis = machine.kinematics.c_axis;
  const best = closestEquivalent(cMath, prevC);
  if (axis.continuous) return best;
  const valid = [-2, -1, 0, 1, 2]
    .map((k) => best + 360 * k)
    .filter((c) => withinLimits(axis, axis.sign * c));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (Math.abs(b - prevC) < Math.abs(a - prevC) ? b : a));
}

/**
 * Find pose {a, c} so that tableRotation(a, c) * direction = +Z.
 *
 * Derivation: let d = (dx, dy, dz), s = sqrt(dx^2 + dy^2) (horizontal
 * length), phi = atan2(dy, dx) (azimuth), theta = atan2(s, dz) (tilt from +Z).
 *   1. Turn C so d lies in the YZ plane: R_C d = (0, +s, dz) needs
 *      phi + c = 90 deg, so c = 90 - phi.
 *   2. Tilt A about X to bring (0, s, dz) up to (0, 0, 1): a = +theta.
 *   The mirror solution is c = -90 - phi, a = -theta.
 * Both are tried; the one inside the limits with the smallest C change from
 * prevPose wins.
 *
 * @throws {IKError} if neither solution fits within the axis limits.
 */
export function inverseKinematics(direction, machine, prevPose = { a: 0, c: 0 }, verticalTolDeg = 1e-6) {
  const d = normalize(direction);
  const aAxis = machine.kinematics.a_axis;
  const s = Math.hypot(d[0], d[1]);
  const theta = (Math.atan2(s, d[2]) * 180) / Math.PI; // 0..180

  if (theta < verticalTolDeg) {
    // Straight up: A = 0, and C can be anything, so keep it where it was.
    const c = pickC(prevPose.c, prevPose.c, machine);
    if (c === null || !withinLimits(aAxis, 0)) throw new IKError('Vertical direction is outside axis limits');
    return { a: 0, c };
  }

  const phi = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
  const valid = [];
  for (const [a, c] of [[theta, 90 - phi], [-theta, -90 - phi]]) {
    if (!withinLimits(aAxis, aAxis.sign * a)) continue;
    const cOk = pickC(c, prevPose.c, machine);
    if (cOk !== null) valid.push({ a, c: cOk });
  }
  if (valid.length === 0)
    throw new IKError(
      `Direction [${d.map((x) => x.toFixed(3)).join(', ')}] needs a tilt of ${theta.toFixed(1)} deg, ` +
        `outside the A limits [${aAxis.min_deg}, ${aAxis.max_deg}] (or C limits) for both IK solutions.`,
    );
  // Prefer the smallest C move, then the smallest A move.
  valid.sort(
    (p, q) => Math.abs(p.c - prevPose.c) - Math.abs(q.c - prevPose.c) || Math.abs(p.a - prevPose.a) - Math.abs(q.a - prevPose.a),
  );
  return valid[0];
}

/** True if some A/C pair within limits points `direction` up. */
export function reachable(direction, machine) {
  try {
    inverseKinematics(direction, machine);
    return true;
  } catch (err) {
    if (err instanceof IKError) return false;
    throw err;
  }
}

/** True if a machine point is outside the XYZ travel limits. */
export function outsideLinearLimits(p, machine) {
  const L = machine.limits;
  const eps = 1e-9;
  return [L.x, L.y, L.z].some(([lo, hi], i) => p[i] < lo - eps || p[i] > hi + eps);
}
