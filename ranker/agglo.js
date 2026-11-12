// Ward agglomerative clustering with desk-aware merging, plus weighted medoids.
// Pure functions (no I/O) so they are trivially testable. O(n^3) worst case; fine for n <~ 1500.
// If n grows past that, replace the min-search with a nearest-neighbour chain (same Lance-Williams update).
import { dot } from './vec.js';

/**
 * @param {Float32Array[]} X              unit vectors
 * @param {Set<number>}    representative indices of representative perfect samples (legacy blocking input)
 * @param {object} o
 * @param {'stop'|'constrained'} o.mode
 *    'stop'        stop at the first merge that would put two representative samples in one cluster.
 *    'constrained' never merge two clusters that both contain a representative sample.
 *                  (Applies with or without deskOf.)
 * @param {number} o.minClusters      also stop when this many clusters remain
 * @param {number} o.maxHeight        also stop when the next merge height exceeds this
 * @param {function(number):string|undefined} o.deskOf  optional; returns the desk key of any
 *    point index that carries a desk (e.g. a perfect sample), or undefined otherwise. When given,
 *    a merge that would join perfect samples of *different* desks is skipped (not stopped) and
 *    clustering continues; samples of the same desk may merge. This implements decision 1
 *    (cross-desk merge = skip, not stop) and guarantees no cluster mixes desks (decision 2).
 * @returns {{clusters:number[][], stopHeight:number|null, heights:number[], skippedMerges:number}}
 *   clusters = arrays of indices into X
 */
export function wardCut(X, representative, { mode = 'stop', minClusters = 1, maxHeight = Infinity, deskOf } = {}) {
  const n = X.length;
  const D = new Float64Array(n * n);                       // squared Euclidean, then Lance-Williams (Ward)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = 0; const a = X[i], b = X[j];
    for (let k = 0; k < a.length; k++) { const t = a[k] - b[k]; s += t * t; }
    D[i * n + j] = D[j * n + i] = s;
  }
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const nRep = new Int32Array(n).fill(0);
  for (const i of representative) nRep[i] = 1;
  const hasDesk = typeof deskOf === 'function';
  // deskSet[c] = Set of desk keys of points (with desk info) in cluster c
  const deskSet = Array.from({ length: n }, () => new Set());
  if (hasDesk) {
    for (let i = 0; i < n; i++) {
      const d = deskOf(i);
      if (d) deskSet[i].add(d);
    }
  }
  let members = Array.from({ length: n }, (_, i) => [i]);
  let alive = n, stopHeight = null;
  const heights = [];
  let skippedMerges = 0;

  while (alive > Math.max(1, minClusters)) {
    let bi = -1, bj = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!active[j]) continue;
        if (nRep[i] && nRep[j] && mode === 'constrained') continue;   // representative clusters never share a cluster
        if (hasDesk) {
          const d1s = deskSet[i], d2s = deskSet[j];
          if (d1s.size > 0 && d2s.size > 0) {
            // Cross-desk merges are skipped. Liked items (no desk) merge freely.
            let conflict = false;
            for (const d1 of d1s) {
              for (const d2 of d2s) {
                if (d1 !== d2) { conflict = true; break; }
              }
              if (conflict) break;
            }
            if (conflict) { skippedMerges++; continue; }
          }
        }
        const d = D[i * n + j];
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;                                      // every remaining pair is forbidden
    if (mode === 'stop' && nRep[bi] && nRep[bj]) { stopHeight = best; break; }   // representative clusters would merge: stop
    if (best > maxHeight) { stopHeight = best; break; }
    const ni = size[bi], nj = size[bj];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const nk = size[k], tot = ni + nj + nk;
      const d = ((ni + nk) * D[bi * n + k] + (nj + nk) * D[bj * n + k] - nk * best) / tot;
      D[bi * n + k] = D[k * n + bi] = d;
    }
    size[bi] = ni + nj; nRep[bi] += nRep[bj];
    if (hasDesk) { for (const d of deskSet[bj]) deskSet[bi].add(d); deskSet[bj].clear(); }
    members[bi] = members[bi].concat(members[bj]);
    active[bj] = 0; alive--; heights.push(best);
  }
  const clusters = [];
  for (let i = 0; i < n; i++) if (active[i]) clusters.push(members[i].sort((a, b) => a - b));
  return { clusters, stopHeight, heights, skippedMerges };
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
