// p / V histogram card: recomputes p (model probability) and V (sampled value)
// for every candidate pool item, straight from the ranker. Nothing is written to
// the DB (Decision 6).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';
import { ensureEmbeddings, ensureFitted } from '../../../ranker/pipeline.js';
import { encode } from '../../../ranker/features.js';
import { value as samplerValue } from '../../../ranker/sampler.js';
import { NULL_RUN } from '../../../ranker/debuglog.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return m % 1 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
};

function poolTimestampMax(pool) {
  let maxTs = null;
  for (const item of pool) {
    const ts = item.first_seen || item.last_shown || item.id;
    if (maxTs === null || ts > maxTs) maxTs = ts;
  }
  return maxTs ?? '';
}

export async function sourceHash() {
  const dataDir = defaultDataDir();
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  const db = resolve(dataDir, cfg.db_file ?? 'daily_brief.db');
  const store = new Store(db);
  try {
    const pool = store.getPool();
    const cfgRaw = readFileSync(join(dataDir, 'config.json'), 'utf8');
    const cfgHash = createHash('sha256').update(cfgRaw).digest('hex').slice(0, 16);
    return createHash('sha256')
      .update(`${pool.length}:${poolTimestampMax(pool)}:${cfgHash}`)
      .digest('hex');
  } finally {
    store.close();
  }
}

export async function generate() {
  const dataDir = defaultDataDir();
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  const rankerCfg = cfg.ranker ?? {};
  const db = resolve(dataDir, cfg.db_file ?? 'daily_brief.db');
  const store = new Store(db);
  try {
    await ensureEmbeddings(store, rankerCfg);
    const fitted = await ensureFitted(store, rankerCfg, { persist: false, run: NULL_RUN });
    const { model, interests } = fitted;
    const pool = store.getPool();
    const embeddings = store.getAllEmbeddings();
    const embById = new Map(embeddings.map((e) => [e.item_id, e]));
    const now = Date.now();
    const features = rankerCfg.features ?? ['bias', 'type', 'author', 'medoid'];
    const ctx = { interests, authorCfg: rankerCfg.authors };
    const samplingCfg = rankerCfg.sampling ?? {};
    const p = [];
    const V = [];
    for (const item of pool) {
      const emb = embById.get(item.id);
      if (!emb) continue;
      const { keys, vals } = encode({ ...item, vec: emb.vec }, ctx, features);
      const pred = model.predict(keys, vals);
      const pi = pred.p;
      const ageDays = Math.max(0, (now - Date.parse(item.published || item.first_seen || now)) / 86400000);
      const daysSinceShown = item.last_shown ? Math.max(0, (now - Date.parse(item.last_shown)) / 86400000) : null;
      const candidate = { ...item, p: pi, age_days: ageDays, days_since_shown: daysSinceShown, times_shown: item.times_shown ?? 0 };
      p.push(round6(pi));
      V.push(round6(samplerValue(candidate, samplingCfg)));
    }
    const n = p.length;
    return {
      p,
      V,
      n,
      pMean: round6(n ? p.reduce((a, b) => a + b, 0) / n : 0),
      pMedian: round6(median(p)),
      vMean: round6(n ? V.reduce((a, b) => a + b, 0) / n : 0),
      vMedian: round6(median(V)),
    };
  } finally {
    store.close();
  }
}
