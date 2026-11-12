// LR model metrics card: prior / keyword / fitted AUC and logLoss from model_eval.
// Reproduces the SQL in simulate/experiments/sacred_runner.py (_load_model_eval).
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';
import { ensureEmbeddings, evalModel } from '../../../ranker/pipeline.js';
import { embeddingOf } from '../../../ranker/embedder.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const ROW_SQL = `
  SELECT embedding_tag, prior_auc, prior_logloss, keyword_auc, keyword_logloss,
         fitted_auc, fitted_logloss
  FROM model_eval WHERE cutoff_date = ?
  ORDER BY embedding_tag, created_at DESC
`;
const MAX_CUTOFF_SQL = 'SELECT MAX(cutoff_date) AS m FROM model_eval';
const COUNT_MAX_SQL = 'SELECT COUNT(*) AS c, MAX(created_at) AS ma FROM model_eval';

const num = (x) => (Number.isFinite(x) ? x : null);
const TEST_FRAC = 0.2;

function rankerCfgFor(dataDir, fullCfg) {
  const ranker = { ...(fullCfg.ranker || {}) };
  // pipeline.js resolves a relative perfect_samples_file against its own module-level
  // data dir, so force an absolute path rooted in the card's dataDir.
  if (ranker.perfect_samples_file && !isAbsolute(ranker.perfect_samples_file)) {
    ranker.perfect_samples_file = resolve(dataDir, ranker.perfect_samples_file);
  }
  return ranker;
}

export async function sourceHash(dataDir = defaultDataDir()) {
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  const db = resolve(dataDir, cfg.db_file ?? 'daily_brief.db');
  const store = new Store(db);
  try {
    const row = store.db.prepare(COUNT_MAX_SQL).get();
    return createHash('sha256').update(`${row.c}:${row.ma ?? ''}`).digest('hex');
  } finally {
    store.close();
  }
}

export async function generate(dataDir = defaultDataDir()) {
  const fullCfg = loadConfig(dataDir, 'config.json') ?? {};
  const cfg = rankerCfgFor(dataDir, fullCfg);
  const db = resolve(dataDir, fullCfg.db_file ?? 'daily_brief.db');
  const store = new Store(db);
  try {
    // (Re)embed everything needed for the eval, then run a chronological holdout
    // eval as of today and persist the row. This is the same path as
    // `ranker/cli.js eval`.
    await ensureEmbeddings(store, cfg);
    const cutoffDate = new Date().toISOString().slice(0, 10);
    const results = await evalModel(store, cfg, { testFrac: TEST_FRAC, cutoffDate });
    const tag = embeddingOf(cfg).tag;
    store.logModelEval({
      embeddingTag: tag,
      cutoffDate,
      testFrac: TEST_FRAC,
      nTrain: results.nTrain,
      nTest: results.nTest,
      results,
    });

    const rows = store.db.prepare(ROW_SQL).all(cutoffDate);
    const newestByTag = new Map();
    for (const r of rows) {
      if (!newestByTag.has(r.embedding_tag)) newestByTag.set(r.embedding_tag, r);
    }

    const tags = [];
    for (const [etag, r] of newestByTag) {
      tags.push({
        tag: etag,
        prior: { auc: num(r.prior_auc), logLoss: num(r.prior_logloss) },
        keyword: { auc: num(r.keyword_auc), logLoss: num(r.keyword_logloss) },
        fitted: { auc: num(r.fitted_auc), logLoss: num(r.fitted_logloss) },
      });
    }
    tags.sort((a, b) => a.tag.localeCompare(b.tag));
    return { cutoffDate, tags };
  } finally {
    store.close();
  }
}
