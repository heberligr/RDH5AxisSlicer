/**
 * Full collision checking before export (milestone 6).
 *
 * 1. PRINT: for every segment, the hotend is tested at sample points on EVERY
 *    layer (not just the first) against the table and every segment printed
 *    before it.
 * 2. TRANSITIONS between segments:
 *    - rotation: while A/C turn, the nozzle waits at safe Z. Nothing already
 *      printed (or the table) may rise to that height at any in-between angle.
 *    - descent: the nozzle comes straight down onto the next segment; the
 *      hotend is tested at several heights on the way.
 * Results are a list of issues, each saying which segment/layer and where.
 */

import { HotendModel, ObstacleSet, checkCollision, makeObstacle, tableMeshForMachine } from './collision.js';
import { machineToPart, partToMachine } from './kinematics.js';
import { toPartFrame } from './slicer.js';

/**
 * @param {object} plan { segmentation, sliced: [...], gcode: { path } }
 * @returns {Promise<{ ok: boolean, issues: object[], checkedPoints: number }>}
 *   issue = { kind: 'print'|'rotation'|'descent', segmentId, layer, message, point (part frame) }
 */
export async function checkPlan(plan, machine, settings, onProgress = () => {}) {
  const hotend = new HotendModel(machine.hotend);
  const spacing = machine.collision.sample_spacing;
  const perLayer = Math.max(1, Math.round(settings.collision_check.points_per_layer));
  const steps = Math.max(2, Math.round(settings.collision_check.rotation_steps));
  const pivot = machine.kinematics.pivot;
  const { segmentation, sliced } = plan;
  const table = tableMeshForMachine(machine);
  const tableObstacle = makeObstacle(table, 'table', spacing);
  const sampled = new Map();
  const obstacleFor = (id) => {
    if (!sampled.has(id)) sampled.set(id, makeObstacle(segmentation.segments[id].mesh, `segment ${id}`, spacing));
    return sampled.get(id);
  };
  const issues = [];
  let checkedPoints = 0;

  for (const [k, sl] of sliced.entries()) {
    const seg = segmentation.segments[sl.segmentId];
    const before = sliced.slice(0, k).map((x) => x.segmentId);
    const obstacles = new ObstacleSet(spacing, [tableObstacle, ...before.map(obstacleFor)]);
    onProgress(`Checking segment ${seg.id} (${k + 1}/${sliced.length})`, k / sliced.length);
    await new Promise((r) => setTimeout(r, 0));

    // ---- 2a. rotation into this segment: printed parts must stay below safe Z
    const prevPose = k === 0 ? { a: 0, c: 0 } : sliced[k - 1].pose;
    const meshes = [table, ...before.map((id) => segmentation.segments[id].mesh)];
    const limit = machine.motion.safe_z - machine.hotend.clearance;
    let rotationIssue = null;
    for (let i = 0; i <= steps && !rotationIssue; i++) {
      const t = i / steps;
      const pose = { a: prevPose.a + (sl.pose.a - prevPose.a) * t, c: prevPose.c + (sl.pose.c - prevPose.c) * t };
      for (const m of meshes) {
        for (let v = 0; v < m.numVerts; v++) {
          const p = partToMachine(m.vertex(v), pose, pivot);
          if (p[2] > limit) {
            rotationIssue = { kind: 'rotation', segmentId: seg.id, layer: null, point: m.vertex(v),
              message: `While turning to segment ${seg.id}, something reaches Z=${p[2].toFixed(1)} - above safe Z minus clearance (${limit}). Raise motion.safe_z.` };
            break;
          }
        }
        if (rotationIssue) break;
      }
    }
    if (rotationIssue) issues.push(rotationIssue);

    // ---- 2b. descent onto the first point
    const firstLayer = sl.layers.find((L) => L.paths.length);
    if (firstLayer) {
      const [fx, fy] = firstLayer.paths[0].points[0];
      const first = partToMachine(toPartFrame(sl, fx, fy, firstLayer.z), sl.pose, pivot);
      for (let i = 1; i <= 5; i++) {
        const z = first[2] + ((machine.motion.safe_z - first[2]) * i) / 5;
        const tip = machineToPart([first[0], first[1], z], sl.pose, pivot);
        const hit = checkCollision(hotend, tip, seg.direction, obstacles);
        checkedPoints++;
        if (hit.hit) {
          issues.push({ kind: 'descent', segmentId: seg.id, layer: 0, point: tip,
            message: `Coming down onto segment ${seg.id}, the hotend hits ${hit.obstacleName} at Z=${z.toFixed(1)}.` });
          break;
        }
      }
    }

    // ---- 1. printing: sample points on every layer
    let firstBad = null, badLayers = 0;
    for (const L of sl.layers) {
      const pts = L.paths.flatMap((p) => p.points);
      if (!pts.length) continue;
      let layerHit = null;
      for (let j = 0; j < perLayer; j++) {
        const [x, y] = pts[Math.floor(((j + 0.5) * pts.length) / perLayer)];
        const tip = toPartFrame(sl, x, y, L.z);
        const hit = checkCollision(hotend, tip, seg.direction, obstacles);
        checkedPoints++;
        if (hit.hit) { layerHit = { tip, hit }; break; }
      }
      if (layerHit) {
        badLayers++;
        if (!firstBad) firstBad = { layer: L.index, ...layerHit };
      }
      if (L.index % 40 === 39) await new Promise((r) => setTimeout(r, 0));
    }
    if (firstBad)
      issues.push({ kind: 'print', segmentId: seg.id, layer: firstBad.layer, point: firstBad.tip,
        message: `Segment ${seg.id}, layer ${firstBad.layer + 1}: the hotend hits ${firstBad.hit.obstacleName}` +
          (badLayers > 1 ? ` (${badLayers} layers affected)` : '') + '.' });
  }
  onProgress('Checked', 1);
  return { ok: issues.length === 0, issues, checkedPoints };
}
