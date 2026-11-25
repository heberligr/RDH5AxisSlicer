/**
 * Hotend collision model: a cone at the nozzle tip plus a cylinder above it.
 *
 * How the check works (kept simple on purpose)
 * --------------------------------------------
 * 1. Every obstacle mesh (bed, already-printed segments) is turned ONCE into
 *    a cloud of points spread over its surface, about `sample_spacing` mm
 *    apart (ObstacleSet).
 * 2. To test a nozzle position we move those points into the TOOL frame (tip
 *    at the origin, tool axis = +Z pointing away from the part) and ask "is
 *    any point inside the hotend shape?" That's a few comparisons per point.
 * 3. Because samples have gaps, the hotend shape is grown by 0.6 x spacing
 *    (plus the configured clearance) so a surface can't sneak between two
 *    samples. The check can report a hit slightly early, never late.
 * 4. A cheap bounding-box test skips obstacles nowhere near the tool.
 *
 * Limitation: only surfaces are sampled, so a hotend buried completely inside
 * a solid with no surface nearby would be missed. That can't happen for a
 * real nozzle printing on top of the part.
 */

import { TriMesh } from './mesh.js';
import { normalize } from './vec.js';
import { rotationFromZ, rotationToZ } from './transforms.js';

const DEG = Math.PI / 180;

export class HotendModel {
  /**
   * Rotationally symmetric hotend envelope in the TOOL frame.
   * z = distance from the nozzle tip along the tool axis (away from the part):
   *   0 .. cone_height               cone, radius = z * tan(half angle)
   *   cone_height .. cylinder_start  neck, radius = cone top radius
   *   cylinder_start .. + height     cylinder, radius = cylinder_radius
   * @param {object} cfg the `hotend` section of machine.yaml
   */
  constructor(cfg) {
    Object.assign(this, {
      cone_half_angle_deg: cfg.cone_half_angle_deg,
      cone_height: cfg.cone_height,
      cylinder_radius: cfg.cylinder_radius,
      cylinder_start: cfg.cylinder_start,
      cylinder_height: cfg.cylinder_height,
      clearance: cfg.clearance ?? 0,
      tip_ignore_height: cfg.tip_ignore_height ?? 0.3,
    });
  }

  get coneTopRadius() { return this.cone_height * Math.tan(this.cone_half_angle_deg * DEG); }
  get totalHeight() { return Math.max(this.cone_height, this.cylinder_start + this.cylinder_height); }
  get maxRadius() { return Math.max(this.coneTopRadius, this.cylinder_radius); }

  /** Envelope radius at height z along the tool axis (0 outside the tool). */
  radiusAt(z) {
    let r = 0;
    if (z >= 0 && z <= this.cone_height) r = z * Math.tan(this.cone_half_angle_deg * DEG);
    else if (z > this.cone_height && z < this.cylinder_start) r = this.coneTopRadius;
    if (z >= this.cylinder_start && z <= this.cylinder_start + this.cylinder_height)
      r = Math.max(r, this.cylinder_radius); // larger one wins where they overlap
    return r;
  }

  /**
   * Is the TOOL-frame point (x, y, z) inside the envelope grown by `inflate`
   * (+ clearance)? Points below tip_ignore_height never count - otherwise the
   * surface the nozzle is printing onto would be a "collision".
   */
  containsLocal(x, y, z, inflate = 0) {
    const grow = inflate + this.clearance;
    if (z < this.tip_ignore_height || z > this.totalHeight + grow) return false;
    const zc = Math.min(Math.max(z, 0), this.totalHeight);
    return Math.hypot(x, y) <= this.radiusAt(zc) + grow;
  }

  /** Triangle mesh of the hotend placed at `tip` with axis `direction` (for drawing). */
  toMesh(tip, direction, sections = 32) {
    const parts = [TriMesh.frustum(0, this.coneTopRadius, 0, this.cone_height, sections)];
    if (this.cylinder_start > this.cone_height + 1e-6)
      parts.push(TriMesh.frustum(this.coneTopRadius, this.coneTopRadius, this.cone_height, this.cylinder_start, sections));
    parts.push(TriMesh.frustum(this.cylinder_radius, this.cylinder_radius, this.cylinder_start,
      this.cylinder_start + this.cylinder_height, sections));
    return TriMesh.concat(parts).transformed(rotationFromZ(direction), [0, 0, 0], tip);
  }
}

// --------------------------------------------------------------------- //
// Obstacles
// --------------------------------------------------------------------- //

/**
 * Deterministic points spread over a mesh surface, at most ~spacing apart.
 * Each triangle is split into an n x n barycentric grid, with n chosen from
 * its longest edge. Returns a flat Float64Array [x,y,z, ...].
 */
export function sampleSurfaceGrid(mesh, spacing) {
  const seen = new Set();
  const out = [];
  const push = (x, y, z) => {
    // Neighbouring triangles share edge points; skip exact duplicates.
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(x, y, z);
  };
  for (let f = 0; f < mesh.numFaces; f++) {
    const [a, b, c] = mesh.triangle(f);
    const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]), Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]));
    const n = Math.max(1, Math.ceil(longest / spacing));
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        push(w * a[0] + u * b[0] + v * c[0], w * a[1] + u * b[1] + v * c[1], w * a[2] + u * b[2] + v * c[2]);
      }
  }
  return Float64Array.from(out);
}

/** One obstacle: a name, its surface samples, and its bounding box. */
export function makeObstacle(mesh, name, spacing) {
  const points = sampleSurfaceGrid(mesh, spacing);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], points[i + k]);
      max[k] = Math.max(max[k], points[i + k]);
    }
  return { name, points, bboxMin: min, bboxMax: max };
}

/** A group of obstacles pre-sampled for fast collision checks. */
export class ObstacleSet {
  constructor(spacing, obstacles = []) {
    this.spacing = spacing;
    this.obstacles = obstacles;
  }

  static fromMeshes(meshes, spacing, names = null) {
    return new ObstacleSet(
      spacing,
      meshes.map((m, i) => makeObstacle(m, names ? names[i] : `obstacle_${i}`, spacing)),
    );
  }

  /**
   * How much to grow the hotend so samples can't miss a surface. The farthest
   * a surface point can be from its nearest sample is a bit under one
   * spacing; 0.6 x spacing is a good compromise for our regular grids.
   */
  get inflate() { return 0.6 * this.spacing; }
}

/**
 * Is the hotend, tip at `tip` and axis along `direction`, hitting anything?
 * `tip` and `direction` are in the part frame (same as the obstacles);
 * `direction` is the build direction: the tool axis points along it, away
 * from the part. Returns the FIRST obstacle hit:
 *   { hit, obstacleName, numPoints, examplePoint }
 */
export function checkCollision(model, tip, direction, obstacles) {
  const d = normalize(direction);
  const R = rotationToZ(d); // part frame -> tool frame
  const grow = obstacles.inflate + model.clearance;
  // Bounding sphere of the grown hotend, for quick rejection.
  const halfH = model.totalHeight / 2;
  const center = [tip[0] + d[0] * halfH, tip[1] + d[1] * halfH, tip[2] + d[2] * halfH];
  const radius = Math.hypot(halfH, model.maxRadius) + grow;
  const r2 = radius * radius;

  for (const obs of obstacles.obstacles) {
    // 1) Sphere vs. obstacle box.
    let boxDist2 = 0;
    for (let k = 0; k < 3; k++) {
      const c = Math.min(Math.max(center[k], obs.bboxMin[k]), obs.bboxMax[k]);
      boxDist2 += (c - center[k]) ** 2;
    }
    if (boxDist2 > r2) continue;
    // 2) + 3) For points inside the sphere, exact test in the tool frame.
    const P = obs.points;
    let count = 0, example = null;
    for (let i = 0; i < P.length; i += 3) {
      const dx = P[i] - center[0], dy = P[i + 1] - center[1], dz = P[i + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const x = P[i] - tip[0], y = P[i + 1] - tip[1], z = P[i + 2] - tip[2];
      const lx = R[0][0] * x + R[0][1] * y + R[0][2] * z;
      const ly = R[1][0] * x + R[1][1] * y + R[1][2] * z;
      const lz = R[2][0] * x + R[2][1] * y + R[2][2] * z;
      if (model.containsLocal(lx, ly, lz, obstacles.inflate)) {
        count++;
        if (!example) example = [P[i], P[i + 1], P[i + 2]];
      }
    }
    if (count > 0) return { hit: true, obstacleName: obs.name, numPoints: count, examplePoint: example };
  }
  return { hit: false, obstacleName: null, numPoints: 0, examplePoint: null };
}

/** Check many tip points (same direction). Returns [{index, result}] for hits. */
export function checkMany(model, tips, direction, obstacles, stopAtFirst = true) {
  const hits = [];
  for (let i = 0; i < tips.length; i++) {
    const result = checkCollision(model, tips[i], direction, obstacles);
    if (result.hit) {
      hits.push({ index: i, result });
      if (stopAtFirst) break;
    }
  }
  return hits;
}

// --------------------------------------------------------------------- //
// Bed geometry
// --------------------------------------------------------------------- //

/** Mesh of the rotary table, top surface at z = surface_z (part frame). */
export function tableMesh(table) {
  const z0 = table.surface_z - table.thickness;
  if (table.shape === 'round')
    return TriMesh.frustum(table.diameter / 2, table.diameter / 2, z0, table.surface_z, 96);
  return TriMesh.box([table.size_x, table.size_y, table.thickness], [-table.size_x / 2, -table.size_y / 2, z0]);
}

/** Rotary table centred on the C axis (pivot X, Y). */
export function tableMeshForMachine(machine) {
  const p = machine.kinematics.pivot;
  return tableMesh(machine.table).translated([p[0], p[1], 0]);
}
