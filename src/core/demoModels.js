/**
 * Demo parts generated in code (no STL needed).
 * All are unions of boxes, so they're guaranteed watertight, and they sit
 * with their lowest face at z = 0, centred on x = y = 0 (the cube) or near it.
 * Requires initGeometry() to have been awaited.
 */

import { TriMesh } from './mesh.js';
import { union } from './geometry.js';

/** Plain cube. Nothing overhangs, so no cuts are needed. */
export function cube(size = 20) {
  return TriMesh.box([size, size, size], [-size / 2, -size / 2, 0]);
}

/**
 * Cube with a horizontal arm sticking out in +X near the top. The arm's
 * underside is a 100% overhang when printed upright.
 * Expected segmentation: 2 segments (cube, then the arm printed along +X).
 */
export function cubeWithArm(size = 20, armLength = 25, armThickness = 8) {
  const arm = TriMesh.box(
    [armLength + 1, armThickness, armThickness], // +1 mm overlap into the cube
    [size / 2 - 1, -armThickness / 2, size - armThickness - 2],
  );
  return union([cube(size), arm]);
}

/**
 * Upright post with a horizontal bar on top (a "T"). Both halves of the bar
 * overhang. Expected segmentation: 3 segments (post, then each bar half
 * printed sideways).
 */
export function tShape(post = 10, height = 30, barLength = 50, barHeight = 8) {
  const stem = TriMesh.box([post, post, height + 1], [-post / 2, -post / 2, 0]); // +1 overlap into the bar
  const bar = TriMesh.box([barLength, post, barHeight], [-barLength / 2, -post / 2, height]);
  return union([stem, bar]);
}

export const DEMO_MODELS = {
  Cube: () => cube(),
  'Cube with arm': () => cubeWithArm(),
  'T-shape': () => tShape(),
};
