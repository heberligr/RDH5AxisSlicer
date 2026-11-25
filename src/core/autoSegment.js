/**
 * Automatic segmentation: propose cuts that remove overhangs.
 *
 * The result is just a list of ordinary Cut objects. The app shows them in
 * the cut editor like hand-made cuts, so you can inspect and change them;
 * nothing is printed without being shown first.
 *
 * Algorithm (one cut at a time, greedy)
 * ------------------------------------
 * repeat:
 *   1. Apply the cuts found so far. In every segment that may still be cut
 *      (depth < max_depth), find connected overhang regions >= min area.
 *   2. Take the biggest region not tried yet. For each candidate build
 *      direction d on the hemisphere (step `candidate_step_deg`, reachable
 *      by the A axis):
 *        - put a cut plane perpendicular to d, `cut_margin` below the
 *          region's lowest point along d
 *        - LOCAL cut: only the piece containing the region moves
 *        - score = overhang left in the new segment
 *                + weight_parent_overhang * overhang newly created in the parent
 *                + weight_tilt * tilt angle
 *   3. Going from the best score up, take the first candidate whose hotend
 *      (pointing along d) does not hit the parent, the other segments or the
 *      bed at sample points of the new segment's first layer.
 *   4. If that beats leaving the region alone (score < region area), keep the
 *      cut; otherwise mark the region "needs supports or manual cut".
 * Every decision is written to a log so you can see why it chose what it did.
 */

import { HotendModel, ObstacleSet, checkMany, makeObstacle, sampleSurfaceGrid, tableMeshForMachine } from './collision.js';
import * as geometry from './geometry.js';
import { reachable } from './kinematics.js';
import { TriMesh } from './mesh.js';
import { overhangArea, overhangRegions } from './overhang.js';
import { Cut, applyCuts, findTargetSegment, tiltDeg } from './segments.js';
import { directionFromAngles } from './transforms.js';
import { dot, norm, normalize, sub } from './vec.js';

/** Candidate build directions on the upper hemisphere, about `stepDeg` apart. */
export function hemisphereDirections(stepDeg, machine = null) {
  const dirs = [[0, 0, 1]];
  for (let tilt = stepDeg; tilt <= 90 + 1e-9; tilt += stepDeg) {
    // Fewer azimuths near the pole so the points are roughly evenly spaced.
    // (A multiple of 4, so the +X/+Y/-X/-Y azimuths are always included.)
    const n = 4 * Math.max(1, Math.round((360 * Math.sin((tilt * Math.PI) / 180)) / stepDeg / 4));
    for (let k = 0; k < n; k++) dirs.push(directionFromAngles(tilt, (360 * k) / n));
  }
  return machine ? dirs.filter((d) => reachable(d, machine)) : dirs;
}

const fmtDir = (d) => `(${d.map((x) => x.toFixed(2)).join(', ')})`;
const regionKey = (segDir, region) => [...segDir, ...region.centroid].map((x) => x.toFixed(1)).join(',');

/**
 * Score one candidate direction for one region (steps 2 of the algorithm).
 * Returns { ok: false, reason } or a full evaluation object.
 */
export function evaluateCandidate(parent, allSegments, region, d, settings) {
  const { cut_margin: margin, weight_parent_overhang: wParent, weight_tilt: wTilt } = settings.auto_segment;
  const threshold = settings.overhang.threshold_deg;
  const mesh = parent.mesh;

  // Plane: perpendicular to d, just below the region's lowest point along d.
  const regionVerts = [];
  for (const f of region.faces) regionVerts.push(...mesh.triangle(f));
  regionVerts.sort((a, b) => dot(a, d) - dot(b, d));
  const offset = dot(regionVerts[0], d) - margin;
  const onPlane = (p) => p.map((x, k) => x - (dot(p, d) - offset) * d[k]);
  // Cut point: must pick this segment when the cut is applied (the cut editor
  // cuts the segment containing the point). Try the region's centre projected
  // onto the plane, then points just below the region's lowest corners.
  const tries = [onPlane(region.centroid), ...regionVerts.slice(0, 12).map(onPlane)];
  const point = tries.find((p) => findTargetSegment(allSegments, p) === allSegments.indexOf(parent));
  if (!point) return { ok: false, reason: 'no cut point inside the segment' };
  const c = region.centroid;

  let split;
  try {
    split = geometry.splitByPlane(mesh, point, d);
  } catch (err) {
    return { ok: false, reason: `cut failed: ${err.message}` };
  }
  const { uppers, lower } = split;
  if (!uppers.length || !lower) return { ok: false, reason: 'plane does not split the segment' };

  // LOCAL cut: the piece containing the region becomes the new segment.
  const dists = uppers.map((p) => geometry.distanceToSurface(p, c));
  const piece = dists.indexOf(Math.min(...dists));
  const newMesh = uppers[piece];
  const parentAfter = geometry.union([lower, ...uppers.filter((_, k) => k !== piece)]);

  // Base faces that don't sit on existing material would be printed in mid-air,
  // so they count as overhang too. (Otherwise "cutting" exactly along an
  // overhang would turn it into a base face and score a perfect 0.)
  const supporters = [parentAfter, ...allSegments.filter((s) => s !== parent).map((s) => s.mesh)];
  const areas = newMesh.faceAreas();
  let unsupported = 0;
  for (const f of geometry.facesOnPlane(newMesh, point, d, 1e-3, -1)) {
    const probe = newMesh.faceCenter(f).map((x, k) => x - 0.02 * d[k]);
    if (!supporters.some((m) => geometry.contains(m, probe))) unsupported += areas[f];
  }
  const remaining = overhangArea(newMesh, d, threshold) + unsupported;
  const parentBefore = overhangArea(mesh, parent.direction, threshold);
  const createdInParent = Math.max(0, overhangArea(parentAfter, parent.direction, threshold) - (parentBefore - region.area));
  const tilt = tiltDeg(d);
  return {
    ok: true,
    direction: d,
    point,
    piece,
    newMesh,
    parentAfter,
    remaining,
    createdInParent,
    tilt,
    score: remaining + wParent * createdInParent + wTilt * tilt,
  };
}

/** Points on the new segment's first layer where the nozzle tip will be. */
export function firstLayerTips(ev, layerHeight, maxPoints = 40) {
  const caps = geometry.facesOnPlane(ev.newMesh, ev.point, ev.direction, 1e-3, -1);
  if (!caps.length) return [];
  const capMesh = TriMesh.concat(caps.map((f) => new TriMesh(ev.newMesh.triangle(f).flat(), [0, 1, 2])));
  const pts = sampleSurfaceGrid(capMesh, 2);
  const n = pts.length / 3;
  const stride = Math.max(1, Math.floor(n / maxPoints));
  const tips = [];
  for (let i = 0; i < n; i += stride)
    tips.push([0, 1, 2].map((k) => pts[3 * i + k] + layerHeight * ev.direction[k]));
  return tips;
}

/**
 * Propose cuts for `part`.
 * @param {TriMesh} part        already oriented and placed on the bed
 * @param {object} machine      parsed machine.yaml
 * @param {object} settings     parsed settings.yaml
 * @param {object} [opts]
 * @param {(msg: string, fraction: number) => void} [opts.onProgress]
 * @returns {Promise<{ cuts: Cut[], log: object[], remaining: object[], segmentation: object }>}
 *   remaining = overhang regions still left ("needs supports or manual cut")
 */
export async function autoSegment(part, machine, settings, { onProgress = () => {} } = {}) {
  const auto = settings.auto_segment;
  const threshold = settings.overhang.threshold_deg;
  const minArea = settings.overhang.min_region_area;
  const hotend = new HotendModel(machine.hotend);
  const spacing = machine.collision.sample_spacing;
  const tableObstacle = makeObstacle(tableMeshForMachine(machine), 'table', spacing);
  const obstacleCache = new Map(); // mesh -> sampled obstacle (meshes are never modified)
  const sampled = (mesh, name) => {
    if (!obstacleCache.has(mesh)) obstacleCache.set(mesh, makeObstacle(mesh, name, spacing));
    return obstacleCache.get(mesh);
  };
  const directions = hemisphereDirections(auto.candidate_step_deg, machine);

  const cuts = [];
  const cutDepth = []; // depth of the segment each cut creates
  const log = [];
  const tried = new Set();
  let seg = applyCuts(part, cuts, machine);

  while (cuts.length < auto.max_cuts) {
    // 1. Next untried region in a segment that may still be cut.
    const depthOf = (s) => (s.cutIndex === null ? 0 : cutDepth[s.cutIndex]);
    let job = null;
    for (const s of seg.segments) {
      if (depthOf(s) >= auto.max_depth) continue;
      for (const region of overhangRegions(s.mesh, s.direction, threshold, minArea)) {
        const key = regionKey(s.direction, region);
        if (!tried.has(key) && (!job || region.area > job.region.area)) job = { s, region, key };
      }
    }
    if (!job) break;
    tried.add(job.key);
    const { s: parent, region } = job;
    const entry = {
      segment: parent.id,
      region: { area: region.area, centroid: region.centroid },
      candidatesTried: directions.length,
      best: [],
      chosen: null,
      decision: '',
    };
    log.push(entry);
    onProgress(`Region of ${region.area.toFixed(0)} mm² in segment ${parent.id}`, 0);

    // 2. Score every candidate direction.
    const evaluations = [];
    const rejected = {};
    for (let i = 0; i < directions.length; i++) {
      const ev = evaluateCandidate(parent, seg.segments, region, directions[i], settings);
      if (ev.ok) evaluations.push(ev);
      else rejected[ev.reason] = (rejected[ev.reason] ?? 0) + 1;
      if (i % 8 === 7) {
        onProgress(`Region of ${region.area.toFixed(0)} mm² in segment ${parent.id}: ${i + 1}/${directions.length} directions`, (i + 1) / directions.length);
        await new Promise((r) => setTimeout(r, 0)); // let the page repaint
      }
    }
    // Best score first. Ties (common on boxy parts) go to the direction that
    // points most directly from the segment toward the overhang.
    const away = sub(region.centroid, parent.mesh.centroid());
    const outward = norm(away) > 1e-9 ? normalize(away) : [0, 0, 1];
    evaluations.sort((a, b) => a.score - b.score || dot(b.direction, outward) - dot(a.direction, outward));
    entry.rejectedBeforeScoring = rejected;

    // 3. Collision check, best score first.
    const others = seg.segments.filter((o) => o.id !== parent.id).map((o) => sampled(o.mesh, `segment ${o.id}`));
    let chosen = null;
    let checked = 0;
    for (const ev of evaluations) {
      if (ev.score >= region.area) break; // no better than leaving the region alone
      const obstacles = new ObstacleSet(spacing, [tableObstacle, makeObstacle(ev.parentAfter, `segment ${parent.id}`, spacing), ...others]);
      const tips = firstLayerTips(ev, settings.slicing.layer_height);
      const hit = checkMany(hotend, tips, ev.direction, obstacles)[0];
      if (entry.best.length < 12) // keep the log readable
        entry.best.push({
          direction: fmtDir(ev.direction), tilt: ev.tilt, score: ev.score, remaining: ev.remaining,
          createdInParent: ev.createdInParent, collision: hit ? hit.result.obstacleName : null,
        });
      checked++;
      if (!hit) { chosen = ev; break; }
      if (checked % 10 === 0) {
        onProgress(`Region of ${region.area.toFixed(0)} mm²: collision-checked ${checked} candidates`, 1);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    entry.collisionChecked = checked;
    if (chosen && !entry.best.some((b) => b.direction === fmtDir(chosen.direction)))
      entry.best.push({ direction: fmtDir(chosen.direction), tilt: chosen.tilt, score: chosen.score, remaining: chosen.remaining, createdInParent: chosen.createdInParent, collision: null });
    // Also log a few top candidates even if they weren't collision-checked.
    for (const ev of evaluations.slice(0, 5))
      if (!entry.best.some((b) => b.direction === fmtDir(ev.direction)))
        entry.best.push({ direction: fmtDir(ev.direction), tilt: ev.tilt, score: ev.score, remaining: ev.remaining, createdInParent: ev.createdInParent, collision: 'not checked' });

    // 4. Keep it or give up on this region.
    if (chosen) {
      cuts.push(new Cut(chosen.point, chosen.direction, { local: true, components: [chosen.piece], name: `auto ${cuts.length + 1}` }));
      cutDepth.push(depthOf(parent) + 1);
      entry.chosen = { direction: fmtDir(chosen.direction), tilt: chosen.tilt, score: chosen.score };
      entry.decision = `cut along ${fmtDir(chosen.direction)} (tilt ${chosen.tilt.toFixed(0)}°), score ${chosen.score.toFixed(1)} vs ${region.area.toFixed(1)} uncut`;
      seg = applyCuts(part, cuts, machine);
    } else if (!evaluations.length) {
      entry.decision = 'no direction could cut here';
    } else if (evaluations[0].score >= region.area) {
      entry.decision = `no cut beats leaving it (best score ${evaluations[0].score.toFixed(1)} vs ${region.area.toFixed(1)})`;
    } else {
      entry.decision = 'every good direction collides with the hotend';
    }
  }

  // Whatever is left needs supports or a manual cut.
  const remaining = [];
  for (const s of seg.segments)
    for (const region of overhangRegions(s.mesh, s.direction, threshold, minArea))
      remaining.push({ segmentId: s.id, area: region.area, centroid: region.centroid, message: 'needs supports or manual cut' });
  onProgress('Done', 1);
  return { cuts, log, remaining, segmentation: seg };
}
