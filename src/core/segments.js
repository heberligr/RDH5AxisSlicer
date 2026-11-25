/**
 * Cuts and segments: turning a part + a list of cut planes into printable
 * chunks.
 *
 * Vocabulary
 * ----------
 *  - A CUT is a plane (point + normal). The normal is the build direction of
 *    the new segment created on the side the normal points to.
 *  - A SEGMENT is a watertight solid with a build direction. Segment 0 (the
 *    "root") is whatever is left on the bed and is printed along +Z.
 *
 * How cuts are applied (applyCuts)
 * --------------------------------
 * Cuts are applied one at a time, in list order:
 *   1. Find the segment that CONTAINS the cut's point. Only that segment is
 *      cut, so a plane that also passes through other segments leaves them.
 *   2. Split it with the plane. The side the normal points to ("upper") may
 *      fall apart into several separate pieces.
 *   3. Normal cut: every upper piece becomes the new segment.
 *      LOCAL cut: only the selected upper pieces become the new segment
 *      (default: the piece nearest the cut point). Unselected pieces are
 *      glued back onto the segment that was cut.
 * Each cut only depends on the cuts before it, so reordering can change the
 * result.
 *
 * Dependencies (which segment must print first)
 * ---------------------------------------------
 * After all cuts, every non-root segment has a flat base face (its "cap") on
 * its cut plane. We probe a tiny bit below each cap face and ask which
 * segment contains that point: that segment supports it and must print
 * first. A topological sort gives the print order. Problems (floating
 * pieces, loops, unreachable directions) become readable warnings.
 */

import * as geometry from './geometry.js';
import { IKError, inverseKinematics } from './kinematics.js';
import { dot, normalize } from './vec.js';

// Tolerances (mm)
const ON_PLANE_TOL = 1e-3; // how close to the plane a cap face must be
const PROBE_DEPTH = 0.02;  // how far below a cap face we probe for the supporter
const SURFACE_TOL = 0.5;   // a cut point this close to a segment's surface still picks it
const MAX_PROBES = 40;     // cap faces probed per segment (largest first)

/** A user (or auto-segmenter) defined cut plane. */
export class Cut {
  /**
   * @param {number[]} point a point on the plane
   * @param {number[]} normal build direction of the new segment (normalised here)
   * @param {object} [opts]
   * @param {boolean} [opts.local] only the selected piece(s) move
   * @param {number[]|null} [opts.components] local cuts: which pieces (null = auto)
   * @param {string} [opts.name]
   */
  constructor(point, normal, { local = false, components = null, name = '' } = {}) {
    this.point = [...point];
    this.normal = normalize(normal);
    this.local = local;
    this.components = components;
    this.name = name;
  }

  toJSON() {
    return { name: this.name, point: this.point, normal: this.normal, local: this.local, components: this.components };
  }

  static fromJSON(d) {
    return new Cut(d.point, d.normal, { local: Boolean(d.local), components: d.components ?? null, name: d.name ?? '' });
  }
}

/** Tilt of a direction away from the bed normal, in degrees. */
export const tiltDeg = (direction) => (Math.acos(Math.min(1, Math.max(-1, normalize(direction)[2]))) * 180) / Math.PI;

/**
 * Index of the segment containing `point` (or touching it, within
 * SURFACE_TOL). null if none.
 */
export function findTargetSegment(segments, point) {
  const windings = segments.map((s) => geometry.windingNumber(s.mesh, point));
  let best = windings.indexOf(Math.max(...windings));
  if (windings[best] > 0.5) return best;
  // Not strictly inside anything: accept a segment whose surface it is
  // (almost) on, e.g. a cut point snapped to a clicked face.
  const dists = segments.map((s) => geometry.distanceToSurface(s.mesh, point));
  best = dists.indexOf(Math.min(...dists));
  return dists[best] <= SURFACE_TOL ? best : null;
}

function nearestPiece(pieces, point) {
  const dists = pieces.map((p) => geometry.distanceToSurface(p, point));
  return dists.indexOf(Math.min(...dists));
}

/**
 * Apply `cuts` to `part` and work out the print order.
 * @param {import('./mesh.js').TriMesh} part
 * @param {Cut[]} cuts
 * @param {object|null} machine optional; if given, every build direction is
 *        checked against the A/C limits
 * @returns {{segments: object[], order: number[], cutReports: object[], warnings: string[], valid: boolean}}
 *   segment = { id, mesh, direction, basePoint, cutIndex (null for root), supports: number[] }
 */
export function applyCuts(part, cuts, machine = null) {
  // Root: lowest vertex is a point on the bed plane.
  let lowest = part.vertex(0);
  for (let i = 1; i < part.numVerts; i++) if (part.vertex(i)[2] < lowest[2]) lowest = part.vertex(i);
  const segments = [{ id: 0, mesh: part, direction: [0, 0, 1], basePoint: lowest, cutIndex: null, supports: [] }];
  const cutReports = [];
  const warnings = [];

  cuts.forEach((cut, i) => {
    const label = `Cut ${i + 1}${cut.name ? ` (${cut.name})` : ''}`;
    const report = {
      cutIndex: i, applied: false, targetSegment: null, newSegment: null,
      pieceCentroids: [], pieceVolumes: [], chosenPieces: [], message: '',
    };
    cutReports.push(report);
    const fail = (msg) => {
      report.message = msg;
      warnings.push(`${label}: ${msg}`);
    };

    const target = findTargetSegment(segments, cut.point);
    if (target === null) return fail('point is not inside any segment - skipped');
    report.targetSegment = target;

    let split;
    try {
      split = geometry.splitByPlane(segments[target].mesh, cut.point, cut.normal);
    } catch (err) {
      return fail(`cut failed: ${err.message}`);
    }
    const { uppers, lower } = split;
    report.pieceCentroids = uppers.map((p) => p.centroid());
    report.pieceVolumes = uppers.map((p) => p.volume());
    if (uppers.length === 0 || lower === null) return fail(`plane does not split segment ${target} - skipped`);

    // Which upper pieces become the new segment?
    let chosen;
    if (!cut.local) {
      chosen = uppers.map((_, k) => k);
    } else {
      chosen = (cut.components ?? []).filter((k) => k >= 0 && k < uppers.length);
      if (cut.components && chosen.length !== cut.components.length)
        warnings.push(`${label}: some selected pieces no longer exist; using the rest`);
      if (chosen.length === 0) chosen = [nearestPiece(uppers, cut.point)];
    }
    report.chosenPieces = chosen;

    const leftover = [lower, ...uppers.filter((_, k) => !chosen.includes(k))];
    segments[target].mesh = geometry.union(leftover);
    const newId = segments.length;
    segments.push({
      id: newId,
      mesh: geometry.union(chosen.map((k) => uppers[k])),
      direction: [...cut.normal],
      basePoint: [...cut.point],
      cutIndex: i,
      supports: [],
    });
    report.applied = true;
    report.newSegment = newId;
    report.message = `split segment ${target}: ${uppers.length} piece(s) above, ${chosen.length} -> segment ${newId}`;
  });

  warnings.push(...computeSupports(segments));
  const { order, warning } = printOrder(segments);
  if (warning) warnings.push(warning);
  warnings.push(...checkFloatingPieces(segments));
  if (machine) {
    for (const s of segments) {
      try {
        inverseKinematics(s.direction, machine);
      } catch (err) {
        if (!(err instanceof IKError)) throw err;
        warnings.push(`Segment ${s.id}: build direction tilts ${tiltDeg(s.direction).toFixed(0)} deg - outside the A-axis limits`);
      }
    }
  }
  return { segments, order, cutReports, warnings, valid: warnings.length === 0 };
}

// --------------------------------------------------------------------- //
// Dependencies
// --------------------------------------------------------------------- //

/** Fill in segment.supports by probing just below each base cap face. */
function computeSupports(segments) {
  const warnings = [];
  for (const seg of segments) {
    if (seg.cutIndex === null) continue;
    let caps = geometry.facesOnPlane(seg.mesh, seg.basePoint, seg.direction, ON_PLANE_TOL);
    if (caps.length === 0) {
      warnings.push(`Segment ${seg.id}: has no flat base face on its cut plane`);
      continue;
    }
    // Probe the biggest cap faces (enough to find every supporter in practice).
    const areas = seg.mesh.faceAreas();
    caps = caps.sort((a, b) => areas[b] - areas[a]).slice(0, MAX_PROBES);
    const supporters = new Set();
    let unsupported = 0;
    for (const f of caps) {
      const c = seg.mesh.faceCenter(f);
      const probe = c.map((x, k) => x - PROBE_DEPTH * seg.direction[k]);
      const hits = segments.filter((o) => o.id !== seg.id && geometry.contains(o.mesh, probe)).map((o) => o.id);
      if (hits.length) hits.forEach((h) => supporters.add(h));
      else unsupported++;
    }
    seg.supports = [...supporters].sort((a, b) => a - b);
    if (supporters.size === 0) warnings.push(`Segment ${seg.id}: its base does not rest on any other segment`);
    else if (unsupported) warnings.push(`Segment ${seg.id}: part of its base (${unsupported} probe(s)) rests on nothing`);
  }
  return warnings;
}

/**
 * Topological sort: supporters before the segments they hold up. Ties go to
 * the lower segment id, so the order is stable. Returns { order, warning }.
 */
export function printOrder(segments) {
  const remaining = new Map(segments.map((s) => [s.id, new Set(s.supports)]));
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort((a, b) => a - b);
    if (ready.length === 0) {
      const stuck = [...remaining.keys()].sort((a, b) => a - b);
      // Fall back to id order so the rest of the app still works.
      return {
        order: [...order, ...stuck],
        warning: `Segments [${stuck.join(', ')}] depend on each other in a loop - no valid print order. Reorder or change the cuts.`,
      };
    }
    const next = ready[0];
    order.push(next);
    remaining.delete(next);
    for (const deps of remaining.values()) deps.delete(next);
  }
  return { order, warning: null };
}

/** Every separate piece of a segment must touch that segment's base plane. */
function checkFloatingPieces(segments) {
  const warnings = [];
  for (const seg of segments) {
    let pieces;
    try {
      pieces = geometry.components(seg.mesh);
    } catch {
      continue;
    }
    const base = dot(seg.basePoint, seg.direction);
    pieces.forEach((piece, k) => {
      let lowest = Infinity;
      for (let v = 0; v < piece.numVerts; v++) lowest = Math.min(lowest, dot(piece.vertex(v), seg.direction));
      if (lowest > base + ON_PLANE_TOL) {
        const where = seg.cutIndex === null ? 'the bed' : 'its cut plane';
        warnings.push(`Segment ${seg.id}: piece ${k} starts ${(lowest - base).toFixed(1)} mm above ${where} (it would print in mid-air)`);
      }
    });
  }
  return warnings;
}
