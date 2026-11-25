/**
 * Planar slicer for one segment.
 *
 * Each segment is printed with ordinary flat layers along its own build
 * direction. To slice it we:
 *   1. rotate it with the SAME rotation the table will apply (A/C from the
 *      inverse kinematics), so its build direction points to +Z, and shift it
 *      so its base sits at z = 0 ("segment frame");
 *   2. cut it into horizontal slices (manifold's slice() gives the outline);
 *   3. make perimeters by insetting the outline, and fill the inside with
 *      straight lines - solid near the top/bottom, sparse elsewhere.
 * Toolpath points are kept in the segment frame (x, y, z). toPartFrame()
 * turns them back into part coordinates for the preview and the G-code.
 *
 * Because we slice ourselves (no external slicer), there's no "the slicer
 * moved my model" offset to detect: the segment frame is exactly known.
 */

import { intersectSections, toManifold } from './geometry.js';
import { inverseKinematics, tableRotation } from './kinematics.js';
import { dot, matVec, transpose } from './vec.js';

/**
 * Hatch (fill) polygons with parallel lines.
 * @param {number[][][]} polygons outlines as [[x,y], ...] (holes included; even-odd rule)
 * @param {number} spacing distance between lines
 * @param {number} angleDeg line direction
 * @returns {number[][][]} line segments [[x1,y1],[x2,y2]], in back-and-forth order
 */
export function hatch(polygons, spacing, angleDeg) {
  if (spacing <= 0 || !polygons.length) return [];
  const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // Rotate so the lines are horizontal, scan, then rotate back.
  const rot = ([x, y]) => [x * c + y * s, -x * s + y * c];
  const unrot = ([x, y]) => [x * c - y * s, x * s + y * c];
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    const pts = poly.map(rot);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (p[1] !== q[1]) edges.push([p, q]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const lines = [];
  // Lines on a fixed global grid (multiples of spacing) so they line up layer to layer.
  let flip = false;
  for (let y = Math.ceil(minY / spacing) * spacing; y <= maxY; y += spacing) {
    const xs = [];
    for (const [p, q] of edges) {
      const lo = Math.min(p[1], q[1]), hi = Math.max(p[1], q[1]);
      if (y < lo || y >= hi) continue; // half-open: each vertex counted once
      xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
    }
    xs.sort((u, v) => u - v);
    const row = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) row.push([unrot([xs[i], y]), unrot([xs[i + 1], y])]);
    if (flip) row.reverse().forEach((seg) => seg.reverse());
    lines.push(...row);
    flip = !flip;
  }
  return lines;
}

/** Re-order paths greedily so each one starts near where the last ended. */
function orderPaths(paths, start) {
  const out = [];
  let pos = start;
  const left = [...paths];
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  while (left.length) {
    let best = 0, bestD = Infinity, bestIdx = 0, bestRev = false;
    left.forEach((p, i) => {
      if (p.closed) {
        // A loop can start at any of its points.
        p.points.forEach((pt, k) => { const d = d2(pt, pos); if (d < bestD) { bestD = d; best = i; bestIdx = k; bestRev = false; } });
      } else {
        const ds = d2(p.points[0], pos), de = d2(p.points[p.points.length - 1], pos);
        if (ds < bestD) { bestD = ds; best = i; bestIdx = 0; bestRev = false; }
        if (de < bestD) { bestD = de; best = i; bestIdx = 0; bestRev = true; }
      }
    });
    const p = left.splice(best, 1)[0];
    let pts = p.points;
    if (p.closed) pts = [...pts.slice(bestIdx), ...pts.slice(0, bestIdx), pts[bestIdx]]; // rotate + close
    else if (bestRev) pts = [...pts].reverse();
    out.push({ ...p, points: pts });
    pos = pts[pts.length - 1];
  }
  return out;
}

/**
 * Slice one segment.
 * @param {object} segment  { id, mesh, direction, basePoint } from applyCuts
 * @param {object} pose     { a, c } table angles for this segment (from IK)
 * @param {object} settings parsed settings.yaml
 * @returns {{ segmentId, pose, R, zBase, layers: { index, z, paths: {kind, points, closed}[] }[] }}
 *   R rotates part -> segment frame; zBase is the base height removed.
 */
export function sliceSegment(segment, pose, settings) {
  const s = settings.slicing;
  const h = s.layer_height, w = s.line_width, P = Math.max(0, Math.round(s.perimeters));
  const R = tableRotation(pose.a, pose.c);
  const zBase = dot(segment.basePoint, segment.direction); // base plane height after rotating
  const rotated = segment.mesh.transformed(R);
  const zTop = rotated.bounds().max[2];
  const nLayers = Math.max(1, Math.round((zTop - zBase) / h));

  // 1. Outline of every layer (sliced through the middle of the layer).
  const solid = toManifold(rotated);
  const outlines = [];
  for (let i = 0; i < nLayers; i++) outlines.push(solid.slice(zBase + (i + 0.5) * h).simplify(0.005));
  solid.delete();

  const layers = [];
  const toDelete = [];
  let pos = [0, 0];
  for (let i = 0; i < nLayers; i++) {
    const A = outlines[i];
    const paths = [];
    if (A.isEmpty()) { layers.push({ index: i, z: (i + 1) * h, paths }); continue; }

    // 2. Perimeters: insets of the outline, inner ones first, outer last.
    for (let k = P - 1; k >= 0; k--) {
      const loop = A.offset(-(k + 0.5) * w, 'Miter', 2);
      toDelete.push(loop);
      for (const poly of loop.toPolygons()) if (poly.length >= 3) paths.push({ kind: k === 0 ? 'outer' : 'inner', points: poly, closed: true });
    }

    // 3. Infill region (overlaps the inner wall by 15% of a line width).
    const inner = A.offset(-(P + 0.35) * w, 'Miter', 2);
    toDelete.push(inner);
    if (!inner.isEmpty()) {
      // Solid where the layers k below or k above are not all filled too.
      const k = Math.max(0, Math.round(s.top_bottom_layers));
      const near = [];
      for (let j = 1; j <= k; j++) near.push(outlines[i - j] ?? null, outlines[i + j] ?? null);
      let sparse;
      if (near.some((o) => !o)) sparse = null; // within k layers of the bottom/top: all solid
      else {
        sparse = intersectSections([inner, ...near]);
        toDelete.push(sparse);
      }
      const solidRegion = sparse ? inner.subtract(sparse) : inner;
      if (sparse) toDelete.push(solidRegion);
      const angle = s.infill_angle_deg * (i % 2 === 0 ? 1 : -1);
      for (const [p, q] of hatch(solidRegion.toPolygons(), w, angle)) paths.push({ kind: 'solid', points: [p, q], closed: false });
      if (sparse && s.infill_density > 0)
        for (const [p, q] of hatch(sparse.toPolygons(), w / s.infill_density, angle)) paths.push({ kind: 'infill', points: [p, q], closed: false });
    }

    // Walls first (in order), then infill; each group ordered to cut travel.
    const walls = orderPaths(paths.filter((p) => p.closed), pos);
    if (walls.length) pos = walls[walls.length - 1].points.at(-1);
    const fill = orderPaths(paths.filter((p) => !p.closed), pos);
    if (fill.length) pos = fill[fill.length - 1].points.at(-1);
    layers.push({ index: i, z: (i + 1) * h, paths: [...walls, ...fill] });
  }
  outlines.forEach((o) => o.delete());
  toDelete.forEach((o) => o.delete());
  return { segmentId: segment.id, pose, R, zBase, layers };
}

/** Segment-frame point (x, y, z above the base) -> part-frame point. */
export function toPartFrame(sliced, x, y, z) {
  return matVec(transpose(sliced.R), [x, y, z + sliced.zBase]);
}

/**
 * Slice every segment in print order. Poses are chosen in order too, so the
 * C axis takes the shortest way from one segment to the next.
 */
export async function sliceAll(segmentation, machine, settings, onProgress = () => {}) {
  const out = [];
  let prev = { a: 0, c: 0 };
  for (const [k, id] of segmentation.order.entries()) {
    const seg = segmentation.segments[id];
    const pose = inverseKinematics(seg.direction, machine, prev);
    onProgress(`Slicing segment ${id} (${k + 1}/${segmentation.order.length})`, k / segmentation.order.length);
    await new Promise((r) => setTimeout(r, 0));
    out.push(sliceSegment(seg, pose, settings));
    prev = pose;
  }
  onProgress('Sliced', 1);
  return out;
}
