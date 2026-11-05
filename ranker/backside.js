// Per-pick "backside" snapshot: facts about WHY a card was picked, frozen at selection time.
// Pure (no I/O). cli.js feeds it vectors; python persists the result into stories.* columns.
//
// Why a snapshot and not a render-time lookup: interests are refitted whenever likes change, and cluster
// ids are positional (index in the wardCut output), so an old brief's `cluster` can point at a DIFFERENT
// medoid after a refit. Anything shown on a card's backside must be captured here, when the pick is made.
import { dot } from './vec.js';

const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };

/** cluster id -> number of candidates assigned to that cluster (the "cluster pool"). */
export function poolCountsByCluster(candidates) {
  const m = new Map();
  for (const c of candidates) {
    if (c.cluster == null) continue;
    const k = Number(c.cluster);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * @param interests   {clusters:[{id, medoid, size, vec:Float32Array}]}  (vec must be hydrated)
 * @param vecOf       (itemId) => Float32Array | null | undefined       the candidate's L2-normalised embedding
 * @param poolCounts  Map from poolCountsByCluster()
 * @returns (candidate) => {cos_dist, cluster_size, cluster_pool, medoid_id}   every field null when unknown
 *
 * cos_dist is measured to the medoid of the cluster the candidate was ASSIGNED to (c.cluster), which is what
 * the card shows as its "main medoid"; it is not necessarily the globally nearest medoid.
 */
export function makeBackside(interests, vecOf, poolCounts) {
  const byId = new Map(interests.clusters.map((cl) => [Number(cl.id), cl]));
  const none = { cos_dist: null, cluster_size: null, cluster_pool: null, medoid_id: null };
  return function backside(c) {
    const cl = c.cluster == null ? undefined : byId.get(Number(c.cluster));
    if (!cl) return { ...none };
    const v = vecOf(c.id);
    // A wrong-length vector would make dot() silently wrong (see vec.js assertVec), so refuse it.
    const usable = !!v && !!cl.vec && v.length === cl.vec.length;
    return {
      cos_dist: usable ? round(Math.max(0, 1 - dot(v, cl.vec)), 4) : null,
      cluster_size: cl.size,
      cluster_pool: poolCounts.get(Number(cl.id)) ?? 0,
      medoid_id: cl.medoid,
    };
  };
}
