// LR model metrics card: prior / keyword / fitted AUC and logLoss from model_eval.
// Reproduces the SQL in simulate/experiments/sacred_runner.py (_load_model_eval).
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';

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

export async function sourceHash() {
  const dataDir = defaultDataDir();
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

export async function generate() {
  const dataDir = defaultDataDir();
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  const db = resolve(dataDir, cfg.db_file ?? 'daily_brief.db');
  const store = new Store(db);
  try {
    const maxRow = store.db.prepare(MAX_CUTOFF_SQL).get();
    const cutoffDate = maxRow ? maxRow.m : null;
    if (!cutoffDate) return { cutoffDate: null, tags: [] };

    const rows = store.db.prepare(ROW_SQL).all(cutoffDate);
    const newestByTag = new Map();
    for (const r of rows) {
      if (!newestByTag.has(r.embedding_tag)) newestByTag.set(r.embedding_tag, r);
    }

    const tags = [];
    for (const [tag, r] of newestByTag) {
      tags.push({
        tag,
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
