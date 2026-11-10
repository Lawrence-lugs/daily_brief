// Sacred-backed ablation: does including liked items in clustering change AUC/logLoss?
//
// Two conditions, identical training rows/labels, differing only in which inputs seed the
// Ward cluster medoids (ranker/interests.js buildInterests):
//
//   A) liked=true   — perfect samples (weight kappa) + liked items (weight 1)   [current behaviour]
//   B) liked=false  — perfect samples only                                     [ablation]
//
// Outputs JSON to stdout: { date, testFrac, nTrain, nTest,
//   liked:   { prior, keyword, fitted, clusters, stopHeight },
//   perfect: { prior, keyword, fitted, clusters, stopHeight } }
//
// Each of prior/keyword/fitted = { auc, logLoss } on the chronological holdout test set.
//
// Usage (from project root):
//   node simulate/experiments/eval_clustering_ablation.js --date 2026-11-01 --testFrac 0.2

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../ranker/store.js';
import { ensureEmbeddings } from '../../ranker/pipeline.js';
import { embeddingOf } from '../../ranker/embedder.js';
import { buildTrainingSet, chronoCut, chronoSplit, foldOf } from '../../ranker/trainer.js';
import { SparseBayesLogReg, MODELS, auc, logLoss } from '../../ranker/model.js';
import { encode } from '../../ranker/features.js';
import { topDistances } from '../../ranker/interests.js';
import { assertVec } from '../../ranker/vec.js';
import { NULL_RUN } from '../../ranker/debuglog.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'config.json');
const DB_FILE = resolve(PROJECT_ROOT, 'daily_brief.db');

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).ranker || {};
}

function evaluate(model, testSet) {
  const scores = [], labels = [];
  for (const ex of testSet) {
    const pred = model.predict(ex.keys, ex.vals);
    scores.push(pred.p);
    labels.push(ex.y);
  }
  return { auc: auc(scores, labels), logLoss: logLoss(scores, labels) };
}

/**
 * Run a full chronological-holdout eval under one clustering mode.
 * @param {boolean} useLikedForClustering  if false, liked items are excluded from buildInterests
 */
async function runCondition(store, cfg, { useLikedForClustering, testFrac, cutoffDate, run } = {}) {
  const { dim } = embeddingOf(cfg);

  // --- Load perfect samples ---
  let perfectSamples = [];
  try {
    perfectSamples = JSON.parse(readFileSync(cfg.perfect_samples_file || 'perfect_samples.json', 'utf8'));
  } catch {
    console.error(`[eval-ablation(${useLikedForClustering})] no perfect_samples.json found`);
  }

  // --- Chronological cut + liked ids (liked items only enter clustering if useLikedForClustering) ---
  const trainingRows = store.getTrainingRows(cutoffDate);
  const allEmbeddings = store.getAllEmbeddings();
  const embById = new Map(allEmbeddings.map((e) => [e.item_id, e]));

  const cut = chronoCut(trainingRows.filter((r) => embById.has(r.item_id)).map((r) => r.date), testFrac);
  const likedIds = store.getLikedWithDates(cfg.interests.maxLikedDays)
    .filter((l) => l.liked_date < cut)
    .map((l) => l.item_id);
  console.error(`[eval-ablation(${useLikedForClustering})] cut=${cut} liked before cut=${likedIds.length}`);

  // --- Perfect samples with vecs ---
  const perfectWithVecs = [];
  for (const ps of perfectSamples) {
    const rawId = ps.id;
    const id = rawId.startsWith('ps:') ? rawId : `ps:${rawId}`;
    const emb = store.getEmbedding(id);
    if (emb) {
      const representative = ps.representative ?? true;
      perfectWithVecs.push({ id, vec: assertVec(emb.vec, dim, id), core: ps.core, representative });
    }
  }

  // --- Liked items with vecs (only used for clustering when useLikedForClustering) ---
  const likedWithVecs = useLikedForClustering
    ? likedWithVecsFrom(likedIds, embById, dim)
    : [];

  // --- Build training set: liked included in clustering iff useLikedForClustering ---
  const vecs = new Map([...embById.entries()].map(([k, v]) => [k, v.vec]));
  const { examples, full: interests } = buildTrainingSet({
    perfect: perfectWithVecs,
    liked: likedWithVecs,
    rows: trainingRows,
    vecs,
    cfg,
  });

  if (examples.length === 0) {
    return {
      useLikedForClustering, cut, nTrain: 0, nTest: 0,
      prior: { auc: NaN, logLoss: NaN },
      keyword: { auc: NaN, logLoss: NaN },
      fitted: { auc: NaN, logLoss: NaN },
      clusters: interests.clusters.length, stopHeight: interests.stopHeight,
      likedCount: likedIds.length,
      perfectCount: perfectWithVecs.length,
    };
  }

  // --- Chronological split ---
  const { train, test } = chronoSplit(examples, testFrac);
  console.error(`[eval-ablation(${useLikedForClustering})] train=${train.length} test=${test.length}`);

  // --- Pool candidates (scaling + keyword baseline) — uses `full` interests (this condition's medoids) ---
  const poolItems = store.getPool();
  const poolById = new Map(poolItems.map((p) => [p.id, p]));
  const poolCandidates = [];
  for (const item of poolItems) {
    const emb = embById.get(item.id);
    if (emb) {
      const ctx = { interests, authorCfg: cfg.authors };
      const { keys, vals } = encode({ ...item, vec: assertVec(emb.vec, dim, item.id) }, ctx, cfg.features);
      poolCandidates.push({ keys, vals });
    }
  }

  // --- Baseline 1: prior only ---
  const PriorModelClass = MODELS[cfg.model?.name ?? 'bayes_lr'] ?? SparseBayesLogReg;
  const priorModel = new PriorModelClass(cfg.model);
  const priorResults = evaluate(priorModel, test);

  // --- Baseline 2: keyword rel ---
  const keywordScores = [], keywordLabels = [];
  for (const ex of test) {
    const poolItem = poolById.get(ex.item_id);
    if (poolItem && typeof poolItem.rel === 'number') {
      keywordScores.push(poolItem.rel);
      keywordLabels.push(ex.y);
    }
  }
  const keywordResults = keywordScores.length > 0
    ? { auc: auc(keywordScores, keywordLabels), logLoss: logLoss(keywordScores, keywordLabels) }
    : { auc: NaN, logLoss: NaN };

  // --- Fitted model ---
  const ModelClass = MODELS[cfg.model?.name ?? 'bayes_lr'] ?? SparseBayesLogReg;
  const fittedModel = new ModelClass(cfg.model);
  if (train.length > 0) {
    fittedModel.fit(train, { scaleSample: poolCandidates });
  }
  const fittedResults = evaluate(fittedModel, test);

  return {
    useLikedForClustering, cut, nTrain: train.length, nTest: test.length,
    prior: priorResults,
    keyword: keywordResults,
    fitted: fittedResults,
    clusters: interests.clusters.length,
    coreClusters: interests.clusters.filter((c) => c.core).length,
    sideClusters: interests.clusters.filter((c) => !c.core).length,
    stopHeight: interests.stopHeight,
    likedCount: likedIds.length,
    perfectCount: perfectWithVecs.length,
  };
}

function likedWithVecsFrom(likedIds, embById, dim) {
  const out = [];
  for (const lid of likedIds) {
    const emb = embById.get(lid);
    if (emb) out.push({ id: lid, vec: assertVec(emb.vec, dim, lid) });
  }
  return out;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      testFrac: { type: 'string' },
    },
  });

  const date = positionals[0] || values.date || null; // allow positional date
  const testFrac = values.testFrac ? parseFloat(values.testFrac) : 0.2;

  if (!date) {
    console.error('Usage: node ranker/eval_clustering_ablation.js --date YYYY-MM-DD [--testFrac 0.2]');
    process.exit(1);
  }

  let cfg = loadConfig();
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
    const runA = await runCondition(store, cfg, {
      useLikedForClustering: true, testFrac, cutoffDate: date, run: NULL_RUN,
    });
    const runB = await runCondition(store, cfg, {
      useLikedForClustering: false, testFrac, cutoffDate: date, run: NULL_RUN,
    });

    const delta = {
      fitted_auc: runB.fitted.auc - runA.fitted.auc,
      fitted_logloss: runB.fitted.logLoss - runA.fitted.logLoss,
      prior_auc: runB.prior.auc - runA.prior.auc,
      prior_logloss: runB.prior.logLoss - runA.prior.logLoss,
      keyword_auc: runB.keyword.auc - runA.keyword.auc,
      keyword_logloss: runB.keyword.logLoss - runA.keyword.logLoss,
    };

    const output = {
      date,
      testFrac,
      cutoff_date: runA.cut,
      nTrain: runA.nTrain,
      nTest: runA.nTest,
      liked: {
        clusters: runA.clusters, coreClusters: runA.coreClusters, sideClusters: runA.sideClusters,
        stopHeight: runA.stopHeight, likedCount: runA.likedCount, perfectCount: runA.perfectCount,
        prior: runA.prior, keyword: runA.keyword, fitted: runA.fitted,
      },
      perfect: {
        clusters: runB.clusters, coreClusters: runB.coreClusters, sideClusters: runB.sideClusters,
        stopHeight: runB.stopHeight, likedCount: runB.likedCount, perfectCount: runB.perfectCount,
        prior: runB.prior, keyword: runB.keyword, fitted: runB.fitted,
      },
      delta,
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
