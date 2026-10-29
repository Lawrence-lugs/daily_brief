// Feature registry. An extractor maps (item, ctx) -> [[key, value], ...].
//   key prefix "n:" => numeric, z-scored by the model; anything else is used as-is (one-hot / bias).
// To add a feature: add an extractor here and put its name in config.ranker.features. To drop one: remove the name.
// To change an encoding: edit that one extractor (and refit; the fit key includes the feature list, not the code,
// so bump `ENCODING_VERSION` when you change an extractor's behaviour).
import { topDistances } from './interests.js';

export const ENCODING_VERSION = 1;

const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** "J. Smith", "John Smith", "Smith, John" -> "smith|j". Single token (org / mononym) -> that token. */
export function authorKey(raw) {
  const s = strip(String(raw ?? '')).toLowerCase().replace(/[^a-z,\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let first = '', last;
  if (s.includes(',')) {
    const [l, f = ''] = s.split(',').map((x) => x.trim());
    last = l.split(' ').pop(); first = f.split(' ')[0] ?? '';
  } else {
    const t = s.split(' '); last = t[t.length - 1]; first = t.length > 1 ? t[0] : '';
  }
  return first ? `${last}|${first[0]}` : last;
}

/** Spec: all authors if <= threshold, otherwise first `head` + last `tail`. */
export function authorKeys(authors, { head = 3, tail = 2, threshold = 5 } = {}) {
  const list = (authors ?? []).map(authorKey).filter(Boolean);
  const pick = list.length > threshold ? [...list.slice(0, head), ...list.slice(-tail)] : list;
  return [...new Set(pick)];
}

export const EXTRACTORS = {
  bias: () => [['b', 1]],
  type: (it) => [[`t:${it.source_type || 'commentary'}`, 1]],
  author: (it, ctx) => {
    const ks = authorKeys(it.authors, ctx?.authorCfg);
    return ks.map((k) => [`a:${k}`, 1 / Math.sqrt(ks.length)]);   // many-author papers must not dominate
  },
  medoid: (it, ctx) => topDistances(ctx.interests, it.vec, 3).map((x, i) => [`n:d${i + 1}`, x.d]),
};

/** @returns {{keys:string[], vals:number[]}} duplicates summed */
export function encode(item, ctx, enabled) {
  const m = new Map();
  for (const name of enabled) {
    const ex = EXTRACTORS[name];
    if (!ex) throw new Error(`unknown feature extractor ${name}`);
    for (const [k, v] of ex(item, ctx)) m.set(k, (m.get(k) ?? 0) + v);
  }
  return { keys: [...m.keys()], vals: [...m.values()] };
}
