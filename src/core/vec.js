/**
 * Tiny 3D vector / 3x3 matrix helpers.
 *
 * Conventions used everywhere in this project:
 *   - A vector or point is a plain array [x, y, z].
 *   - A 3x3 matrix is an array of 3 rows: [[a, b, c], [d, e, f], [g, h, i]].
 *   - Matrices act on column vectors: v_new = M * v  ->  matVec(M, v).
 */

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/** Unit vector in the direction of a. Throws for a zero vector. */
export function normalize(a) {
  const n = norm(a);
  if (n < 1e-12) throw new Error('Cannot normalize a zero-length vector');
  return [a[0] / n, a[1] / n, a[2] / n];
}

export const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** M * v */
export const matVec = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];

/** A * B */
export function matMul(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return out;
}

/** Transpose (= inverse, for rotation matrices). */
export const transpose = (M) => [
  [M[0][0], M[1][0], M[2][0]],
  [M[0][1], M[1][1], M[2][1]],
  [M[0][2], M[1][2], M[2][2]],
];

export const det = (M) =>
  M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
  M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
  M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const DEG = Math.PI / 180;
