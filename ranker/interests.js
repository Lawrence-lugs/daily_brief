// Interest vectors (medoids) from perfect samples + liked items. Pure: takes vectors, returns plain objects.
import { wardCut, weightedMedoid } from './agglo.js';
import { dot } from './vec.js';

/**
 * @param {{id:string, vec:Float32Array, core:boolean}[]} perfect
 * @param {{id:string, vec:Float32Array}[]} liked        already filtered to max_liked_days, deduped
 * @param {{kappa:number, mode?:string, minClusters?:number, maxHeight?:number}} cfg
 */
export function buildInterests(perfect, liked, cfg) {
  const seen = new Set(perfect.map((p) => p.id));
  const pts = [
    ...perfect.map((p) => ({ ...p, perfect: true, w: cfg.kappa })),
    ...liked.filter((l) => !seen.has(l.id)).map((l) => ({ ...l, perfect: false, w: 1 })),
  ];
  if (!pts.length) throw new Error('no perfect samples and no liked items: cannot build interests');
  const X = pts.map((p) => p.vec), w = pts.map((p) => p.w);
  const perfIdx = new Set(); pts.forEach((p, i) => p.perfect && perfIdx.add(i));
  const { clusters, stopHeight } = wardCut(X, perfIdx, cfg);
  return {
    stopHeight,
    clusters: clusters.map((idx, id) => {
      const m = weightedMedoid(X, w, idx);
      return {
        id, medoid: pts[m].id, vec: X[m], size: idx.length,
        core: idx.some((i) => pts[i].perfect && pts[i].core),   // has >=1 core perfect sample
        members: idx.map((i) => pts[i].id),
      };
    }),
  };
}

/** m smallest cosine distances to medoids (ascending), padded with the last value if fewer than m clusters. */
export function topDistances(interests, vec, m = 3) {
  const ds = interests.clusters.map((c) => ({ cid: c.id, d: 1 - dot(vec, c.vec) })).sort((a, b) => a.d - b.d).slice(0, m);
  while (ds.length < m) ds.push({ ...ds[ds.length - 1] });
  return ds;
}
export const nearest = (interests, vec) => topDistances(interests, vec, 1)[0];

// persistence helpers: vectors are NOT stored in the JSON (they live in `embeddings`), only medoid ids.
export const serializeInterests = (it) => JSON.stringify({
  stopHeight: it.stopHeight,
  clusters: it.clusters.map(({ vec, ...rest }) => rest),
});
export function hydrateInterests(json, getVec) {
  const o = JSON.parse(json);
  return { ...o, clusters: o.clusters.map((c) => ({ ...c, vec: getVec(c.medoid) })) };
}
