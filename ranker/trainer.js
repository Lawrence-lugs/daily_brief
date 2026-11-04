// Cross-fitted training set. WHY: liked items are themselves used to build the medoids, so a liked item sits
// at distance ~0 from "its" medoid. Training on that leaks the label into d1 and inflates its weight.
// Fix: split items into K folds by hash; features for an example in fold f use interests built WITHOUT the
// liked items of fold f. Perfect samples are always included (they are never training examples).
import { createHash } from 'node:crypto';
import { buildInterests } from './interests.js';
import { encode } from './features.js';
import { assertVec } from './vec.js';
import { embeddingOf } from './embedder.js';

export const foldOf = (id, K) => parseInt(createHash('sha1').update(String(id)).digest('hex').slice(0, 8), 16) % K;

/**
 * @param perfect [{id,vec,core}]   liked [{id,vec}]   vecs Map(item_id -> vec)
 * @param rows    [{item_id, source_type, authors:string[], y:0|1, date}]   (from the training_examples view)
 * @param cfg     config.ranker
 * @returns {{examples:{keys,vals,y,weight,date}[], full:object}}  `full` = interests built from everything (used at serving time)
 */
export function buildTrainingSet({ perfect, liked, rows, vecs, cfg }) {
  const K = cfg.crossFit.folds;
  const dim = embeddingOf(cfg).dim;
  const full = buildInterests(perfect, liked, cfg.interests);
  const foldI = Array.from({ length: K }, (_, f) => {
    const sub = liked.filter((l) => foldOf(l.id, K) !== f);
    return (perfect.length + sub.length) ? buildInterests(perfect, sub, cfg.interests) : full;
  });
  const examples = [];
  for (const r of rows) {
    const vec = vecs.get(r.item_id);
    if (!vec) continue;
    assertVec(vec, dim, r.item_id);
    const fold = foldOf(r.item_id, K);
    const ctx = { interests: foldI[fold], authorCfg: cfg.authors };
    const { keys, vals } = encode({ ...r, vec }, ctx, cfg.features);
    examples.push({ item_id: r.item_id, keys, vals, y: r.y, weight: 1, date: r.date, fold });
  }
  return { examples, full };
}

/** Cut date: the first date of the newest (testFrac) share of distinct dates. */
export function chronoCut(dates, testFrac = 0.2) {
  const sorted = [...new Set(dates)].sort();
  return sorted[Math.floor(sorted.length * (1 - testFrac))] ?? sorted.at(-1);
}

/** Chronological holdout: fit on the first (1-testFrac) of dates, evaluate on the rest. */
export function chronoSplit(examples, testFrac = 0.2) {
  const cut = chronoCut(examples.map((e) => e.date), testFrac);
  return { train: examples.filter((e) => e.date < cut), test: examples.filter((e) => e.date >= cut), cut };
}
