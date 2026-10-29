// Ward agglomerative clustering with the "perfect-sample" stopping rule, plus weighted medoids.
// Pure functions (no I/O) so they are trivially testable. O(n^3) worst case; fine for n <~ 1500.
// If n grows past that, replace the min-search with a nearest-neighbour chain (same Lance-Williams update).
import { dot } from './vec.js';

/**
 * @param {Float32Array[]} X          unit vectors
 * @param {Set<number>}    perfect    indices of perfect samples
 * @param {object} o
 * @param {'stop'|'constrained'} o.mode
 *    'stop'        (spec) stop at the first merge that would put two perfect samples in one cluster.
 *                  The cut height is therefore the largest one that still separates all perfect samples.
 *    'constrained' never merge two clusters that both contain a perfect sample, but keep merging the rest.
 *                  Use this if 'stop' collapses into many singleton clusters (two near-duplicate perfect samples).
 * @param {number} o.minClusters      also stop when this many clusters remain (use as fixed-k cut / fallback)
 * @param {number} o.maxHeight        also stop when the next merge height exceeds this
 * @returns {{clusters:number[][], stopHeight:number|null, heights:number[]}}  clusters = arrays of indices into X
 */
export function wardCut(X, perfect, { mode = 'stop', minClusters = 1, maxHeight = Infinity } = {}) {
  const n = X.length;
  const D = new Float64Array(n * n);                       // squared Euclidean, then Lance-Williams (Ward)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = 0; const a = X[i], b = X[j];
    for (let k = 0; k < a.length; k++) { const t = a[k] - b[k]; s += t * t; }
    D[i * n + j] = D[j * n + i] = s;
  }
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const nPerf = new Int32Array(n);
  for (const i of perfect) nPerf[i] = 1;
  let members = Array.from({ length: n }, (_, i) => [i]);
  let alive = n, stopHeight = null;
  const heights = [];

  while (alive > Math.max(1, minClusters)) {
    let bi = -1, bj = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!active[j]) continue;
        if (mode === 'constrained' && nPerf[i] && nPerf[j]) continue;
        const d = D[i * n + j];
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;                                      // every remaining pair is forbidden
    if (best > maxHeight) { stopHeight = best; break; }
    if (mode === 'stop' && nPerf[bi] && nPerf[bj]) { stopHeight = best; break; }
    const ni = size[bi], nj = size[bj];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const nk = size[k], tot = ni + nj + nk;
      const d = ((ni + nk) * D[bi * n + k] + (nj + nk) * D[bj * n + k] - nk * best) / tot;
      D[bi * n + k] = D[k * n + bi] = d;
    }
    size[bi] = ni + nj; nPerf[bi] += nPerf[bj];
    members[bi] = members[bi].concat(members[bj]);
    active[bj] = 0; alive--; heights.push(best);
  }
  const clusters = [];
  for (let i = 0; i < n; i++) if (active[i]) clusters.push(members[i].sort((a, b) => a - b));
  return { clusters, stopHeight, heights };
}

/**
 * Weighted medoid: argmin_{p in C} sum_i w_i ||p - x_i||^2.
 * Since sum_i w_i||p-x_i||^2 = W||p-c_w||^2 + const (c_w = weighted centroid), this is the member nearest c_w.
 */
export function weightedMedoid(X, w, idx) {
  const d = X[0].length, c = new Float64Array(d);
  let W = 0;
  for (const i of idx) { W += w[i]; for (let k = 0; k < d; k++) c[k] += w[i] * X[i][k]; }
  for (let k = 0; k < d; k++) c[k] /= W;
  let best = idx[0], bd = Infinity;
  for (const i of idx) {
    let s = 0; for (let k = 0; k < d; k++) { const t = X[i][k] - c[k]; s += t * t; }
    if (s < bd) { bd = s; best = i; }
  }
  return best;
}
export { dot };
