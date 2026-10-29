// Cross-fitted training set. WHY: liked items are themselves used to build the medoids, so a liked item sits
// at distance ~0 from "its" medoid. Training on that leaks the label into d1 and inflates its weight.
// Fix: split items into K folds by hash; features for an example in fold f use interests built WITHOUT the
// liked items of fold f. Perfect samples are always included (they are never training examples).
import { createHash } from 'node:crypto';
import { buildInterests } from './interests.js';
import { encode } from './features.js';

export const foldOf = (id, K) => parseInt(createHash('sha1').update(String(id)).digest('hex').slice(0, 8), 16) % K;

/**
 * @param perfect [{id,vec,core}]   liked [{id,vec}]   vecs Map(item_id -> vec)
 * @param rows    [{item_id, source_type, authors:string[], y:0|1, date}]   (from the training_examples view)
 * @param cfg     config.ranker
 * @returns {{examples:{keys,vals,y,weight,date}[], full:object}}  `full` = interests built from everything (used at serving time)
 */
export function buildTrainingSet({ perfect, liked, rows, vecs, cfg }) {
  const K = cfg.crossFit.folds;
  const full = buildInterests(perfect, liked, cfg.interests);
  const foldI = Array.from({ length: K }, (_, f) => {
    const sub = liked.filter((l) => foldOf(l.id, K) !== f);
    return (perfect.length + sub.length) ? buildInterests(perfect, sub, cfg.interests) : full;
  });
  const examples = [];
  for (const r of rows) {
    const vec = vecs.get(r.item_id);
    if (!vec) continue;
    const ctx = { interests: foldI[foldOf(r.item_id, K)], authorCfg: cfg.authors };
    const { keys, vals } = encode({ ...r, vec }, ctx, cfg.features);
    examples.push({ keys, vals, y: r.y, weight: 1, date: r.date });
  }
  return { examples, full };
}

/** Chronological holdout: fit on the first (1-testFrac) of dates, evaluate on the rest. */
export function chronoSplit(examples, testFrac = 0.2) {
  const dates = [...new Set(examples.map((e) => e.date))].sort();
  const cut = dates[Math.floor(dates.length * (1 - testFrac))] ?? dates.at(-1);
  return { train: examples.filter((e) => e.date < cut), test: examples.filter((e) => e.date >= cut) };
}
