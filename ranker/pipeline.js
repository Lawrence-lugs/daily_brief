// Pipeline functions: embeddings, fitting, candidate preparation.
import { embedTexts, textOf, textHash, embeddingOf } from './embedder.js';
import { SQL } from './store.js';
import { createHash } from 'node:crypto';
import { buildTrainingSet, chronoCut, chronoSplit, foldOf } from './trainer.js';
import { SparseBayesLogReg, MODELS, auc, logLoss } from './model.js';
import { encode } from './features.js';
import { topDistances } from './interests.js';
import { assertVec } from './vec.js';
import { codeHashes, NULL_RUN } from './debuglog.js';

const ENCODING_VERSION = 1; // bump when encode() schema changes

/** Compute a YYYY-MM-DD cutoff date `days` days before now. */
function cutoffDateDays(days) {
  if (!days || days <= 0) return null;
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Ensure all pool/story items and perfect samples have embeddings.
 * Re-embeds pool items if their text_hash changed.
 * @param {import('./store.js').Store} store
 * @param {object} cfg - config.ranker
 * @param {{persist?: boolean}} opts
 */
export async function ensureEmbeddings(store, cfg, { persist = true } = {}) {
  const emb = embeddingOf(cfg);
  // Pool items: missing, embedded by another model, or text_hash mismatch
  const poolItems = store.getPool();
  const existingEmbs = store.getAllEmbeddings();
  const embById = new Map(existingEmbs.map((e) => [e.item_id, e]));
  
  const toEmbed = [];
  for (const item of poolItems) {
    const text = textOf(item.title, item.snippet);
    const h = textHash(text);
    const existing = embById.get(item.id);
    if (!existing || existing.model !== emb.tag || existing.text_hash !== h) {
      toEmbed.push({ id: item.id, text, hash: h });
    }
  }
  
  if (toEmbed.length > 0) {
    const texts = toEmbed.map((t) => t.text);
    const vecs = await embedTexts(texts, emb);
    for (let i = 0; i < toEmbed.length; i++) {
      if (persist) store.upsertEmbedding(toEmbed[i].id, emb.tag, toEmbed[i].hash, emb.dim, vecs[i]);
    }
    console.error(`[embed] inserted/updated ${toEmbed.length} pool embeddings`);
  } else {
    console.error('[embed] all pool items already embedded');
  }

  // Stories not in pool (fallback)
  const missingStories = store.getMissingEmbeddings()
    .filter((m) => !embById.has(m.id) && !toEmbed.some((t) => t.id === m.id));
  if (missingStories.length > 0) {
    const texts = missingStories.map((m) => textOf(m.title, m.body));
    const vecs = await embedTexts(texts, emb);
    for (let i = 0; i < missingStories.length; i++) {
      const h = textHash(texts[i]);
      if (persist) store.upsertEmbedding(missingStories[i].id, emb.tag, h, emb.dim, vecs[i]);
    }
    console.error(`[embed] inserted ${missingStories.length} story embeddings`);
  }

  // Perfect samples
  const psFile = cfg.perfect_samples_file || 'perfect_samples.json';
  let perfectSamples = [];
  try {
    const { readFileSync } = await import('node:fs');
    perfectSamples = JSON.parse(readFileSync(psFile, 'utf8'));
  } catch {
    console.error('[embed] no perfect_samples.json found');
  }
  if (perfectSamples.length > 0) {
    const texts = perfectSamples.map((ps) => textOf(ps.title, ps.snippet));
    const vecs = await embedTexts(texts, emb);
    for (let i = 0; i < perfectSamples.length; i++) {
      const rawId = perfectSamples[i].id;
      const id = rawId.startsWith('ps:') ? rawId : `ps:${rawId}`;
      const h = textHash(texts[i]);
      const existing = store.getEmbedding(id);
      if (!existing || existing.model !== emb.tag || existing.text_hash !== h) {
        if (persist) store.upsertEmbedding(id, emb.tag, h, emb.dim, vecs[i]);
        console.error(`[embed] perfect sample ${id} embedded`);
      }
    }
  }

  // Prune embeddings written by other models (now that we've re-embedded what we need).
  // This avoids data loss if embedding fails partway.
  if (persist) {
    store.pruneEmbeddingsOtherModels(emb.tag);
    store.pruneEmbeddings();
  }
}

/**
 * Build fitKey for caching.
 */
function buildInputsHash(perfectSamples, likedIds, trainingRows, cfg) {
  const payload = [
    perfectSamples.map((ps) => [ps.id, textHash(textOf(ps.title, ps.snippet)), ps.core, ps.representative]).sort(),
    likedIds.slice().sort(),
    trainingRows.map((r) => [r.item_id, r.y, r.source_type, (r.authors || []).join(',')]).sort(),
    cfg.interests,
    cfg.features,
    cfg.authors,
    cfg.crossFit,
    cfg.model,
    cfg.embedding ?? null,
    ENCODING_VERSION,
  ];
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function sha1(obj) {
  return createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

function fitPartsOf(inputsHash, code, trainingHash) {
  return { inputs: inputsHash, trainingExamples: trainingHash, ...code };
}

function diffParts(stored, current) {
  if (!stored) return Object.keys(current);
  return Object.keys(current).filter((k) => stored[k] !== current[k]);
}

/**
 * Ensure model and interests are fitted (or loaded from cache).
 * @param {import('./store.js').Store} store
 * @param {object} cfg - config.ranker
 * @param {{persist?: boolean, force?: boolean, run?: object, cutoffDate?: string}} opts
 *   cutoffDate: YYYY-MM-DD, training rows after this date are excluded (for chronological holdout)
 */
export async function ensureFitted(store, cfg, { persist = true, force = false, run = NULL_RUN, cutoffDate = null } = {}) {
  const { dim } = embeddingOf(cfg);
  // Load perfect samples
  let perfectSamples = [];
  try {
    const { readFileSync } = await import('node:fs');
    perfectSamples = JSON.parse(readFileSync(cfg.perfect_samples_file || 'perfect_samples.json', 'utf8'));
  } catch {
    console.error('[refit] no perfect_samples.json found');
  }

  const likedCutoff = cutoffDateDays(cfg.interests.maxLikedDays);
  const likedIds = store.getLikedIds(likedCutoff);
  const trainingRows = store.getTrainingRows(cutoffDate);
  const inputsHash = buildInputsHash(perfectSamples, likedIds, trainingRows, cfg);
  const code = codeHashes();

  console.error('[refit] building interests and training examples...');

  // Build perfect samples with vectors
  const perfectWithVecs = [];
  for (const ps of perfectSamples) {
    const rawId = ps.id;
    const id = rawId.startsWith('ps:') ? rawId : `ps:${rawId}`;
    const emb = store.getEmbedding(id);
    if (emb) {
      // Default representative=true for backward compatibility (old behavior: all perfect samples blocked clustering)
      const representative = ps.representative ?? true;
      if (ps.representative === undefined) {
        console.error(`[refit] WARNING: perfect sample ${id} missing 'representative' field, defaulting to true`);
      }
      perfectWithVecs.push({ id, vec: assertVec(emb.vec, dim, id), core: ps.core, representative });
    } else {
      console.error(`[refit] WARNING: perfect sample ${id} has no embedding`);
    }
  }

  // Get liked items with vectors
  const likedWithVecs = [];
  const allEmbeddings = store.getAllEmbeddings();
  const embById = new Map(allEmbeddings.map((e) => [e.item_id, e]));
  for (const lid of likedIds) {
    const emb = embById.get(lid);
    if (emb) {
      likedWithVecs.push({ id: lid, vec: assertVec(emb.vec, dim, lid) });
    }
  }

  // Cold start: no perfect samples and no liked items -> return empty interests + prior-only model
  if (perfectWithVecs.length === 0 && likedWithVecs.length === 0) {
    console.error('[refit] cold start: no perfect samples and no liked items, using prior only');
    const interests = { stopHeight: null, clusters: [] };
    const ModelClass = MODELS[cfg.model?.name ?? 'bayes_lr'] ?? SparseBayesLogReg;
    const model = new ModelClass(cfg.model);
    const parts = fitPartsOf(inputsHash, code, sha1([]));
    const fitKey = sha1(parts);
    if (persist) {
      store.setState('fit_key', fitKey);
      store.setState('fit_parts', JSON.stringify(parts));
      store.setState('interests', JSON.stringify(interests));
      store.setState('model', JSON.stringify(model.toJSON()));
    }
    return { interests, model, fitKey, fromCache: false };
  }

  // Build interests (full) and cross-fitted training examples
  // vecs must be Map(item_id -> Float32Array), not embedding objects
  const vecs = new Map([...embById.entries()].map(([k, v]) => [k, v.vec]));
  const { examples, full: interests } = buildTrainingSet({
    perfect: perfectWithVecs,
    liked: likedWithVecs,
    rows: trainingRows,
    vecs,
    cfg,
  });

  // Log dropped training rows (missing embeddings)
  const rowsWithEmb = trainingRows.filter((r) => embById.has(r.item_id)).length;
  if (rowsWithEmb < trainingRows.length) {
    console.error(`[refit] WARNING: ${trainingRows.length - rowsWithEmb} training rows skipped (missing embeddings)`);
  }

  // Diagnostics logging (as per PLAN)
  const coreClusters = interests.clusters.filter((c) => c.core).length;
  const sideClusters = interests.clusters.filter((c) => !c.core).length;
  const sizeHist = {};
  for (const c of interests.clusters) {
    sizeHist[c.size] = (sizeHist[c.size] || 0) + 1;
  }
  const positives = examples.filter((e) => e.y === 1).length;
  console.error(
    `[refit] perfect=${perfectWithVecs.length} liked=${likedWithVecs.length} ` +
    `clusters=${interests.clusters.length} (core=${coreClusters} side=${sideClusters}) ` +
    `stopHeight=${interests.stopHeight?.toFixed(4) ?? 'N/A'} ` +
    `sizes=${JSON.stringify(sizeHist)} ` +
    `examples=${examples.length} positives=${positives}`
  );

  const srcById = new Map(trainingRows.map((r) => [r.item_id, r.source_type]));
  const balance = {};
  const monthBalance = {};
  const foldSizes = {};
  for (const e of examples) {
    const src = srcById.get(e.item_id) ?? 'unknown';
    const month = (e.date || '').slice(0, 7);
    const side = e.y === 1 ? 'pos' : 'neg';
    balance[src] ??= { pos: 0, neg: 0 };
    balance[src][side]++;
    monthBalance[month] ??= { pos: 0, neg: 0 };
    monthBalance[month][side]++;
    foldSizes[e.fold] = (foldSizes[e.fold] || 0) + 1;
  }
  run.event('train_set', {
    rows: trainingRows.length,
    examples: examples.length,
    droppedNoEmb: trainingRows.filter((r) => !embById.has(r.item_id)).map((r) => r.item_id),
    vecsChecked: vecs.size,
    perfect: perfectWithVecs.length,
    liked: likedWithVecs.length,
    clusters: interests.clusters.length,
    stopHeight: interests.stopHeight,
    balanceBySource: balance,
    balanceByMonth: monthBalance,
    foldSizes,
  });

  const poolCandidates = [];
  for (const item of store.getPool()) {
    const emb = embById.get(item.id);
    if (emb) {
      const ctx = { interests, authorCfg: cfg.authors };
      const { keys, vals } = encode({ ...item, vec: emb.vec }, ctx, cfg.features);
      poolCandidates.push({ keys, vals });
    }
  }
  const trainingHash = sha1([
    examples.map((e) => [e.keys, e.vals, e.y, e.weight, e.fold]),
    poolCandidates.map((c) => [c.keys, c.vals]),
  ]);
  const parts = fitPartsOf(inputsHash, code, trainingHash);
  const fitKey = sha1(parts);

  if (!force && store.getState('fit_key') === fitKey) {
    console.error('[refit] cache hit, loading interests and model from ranker_state');
    run.event('fit_cache', { hit: true, fitKey, parts });
    const modelJson = JSON.parse(store.getState('model'));
    const ModelClass = MODELS[cfg.model?.name ?? 'bayes_lr'] ?? SparseBayesLogReg;
    const model = ModelClass.fromJSON(modelJson, cfg.model);
    return { interests: JSON.parse(store.getState('interests')), model, fitKey, fromCache: true };
  }
  const storedParts = store.getState('fit_parts');
  const changed = diffParts(storedParts ? JSON.parse(storedParts) : null, parts);
  const why = force ? 'forced' : changed.join(', ');
  console.error(`[refit] cache miss (${why}), fitting model...`);
  run.event('fit_cache', { hit: false, fitKey, parts, changed });

  const ModelClass = MODELS[cfg.model?.name ?? 'bayes_lr'] ?? SparseBayesLogReg;
  const model = new ModelClass(cfg.model);
  if (examples.length > 0) {
    const onSweep = run.enabled ? (s) => run.event('fit_sweep', s, 'trace') : undefined;
    model.fit(examples, { scaleSample: poolCandidates, onSweep });
  } else {
    console.error('[refit] no training examples, model stays at prior');
  }

  if (examples.length > 0) {
    const scores = examples.map((e) => model.predict(e.keys, e.vals).p);
    const ys = examples.map((e) => e.y);
    const sorted = model.weights().sort((a, b) => b.w - a.w);
    run.event('fit', {
      diag: model.diag,
      trainLogLoss: logLoss(scores, ys),
      trainAUC: auc(scores, ys),
      scaleSample: poolCandidates.length,
      topPositive: sorted.slice(0, 10),
      topNegative: sorted.slice(-10).reverse(),
    });
  }

  if (persist) {
    model.assertFinite();
    store.setState('fit_key', fitKey);
    store.setState('fit_parts', JSON.stringify(parts));
    store.setState('interests', JSON.stringify(interests));
    store.setState('model', JSON.stringify(model.toJSON()));
  }

  return { interests, model, fitKey, fromCache: false };
}

/**
 * Prepare candidates for selection.
 * @param {import('./store.js').Store} store
 * @param {object} cfg - config.ranker
 * @param {{interests, model}} fitted
 * @param {string} dateKey - YYYY-MM-DD
 * @param {Date} now
 */
export function prepareCandidates(store, cfg, { interests, model }, dateKey, now, run = NULL_RUN) {
  const { dim } = embeddingOf(cfg);
  const pool = store.getPool();
  const embeddings = store.getAllEmbeddings();
  const embById = new Map(embeddings.map((e) => [e.item_id, e]));
  const lastShown = new Map(store.getLastShown(dateKey).map((r) => [r.item_id, r.last]));

  // Exclude items the user has ever liked or saved from re-selection.
  const likedCutoff = cutoffDateDays(cfg.interests.maxLikedDays);
  const likedIds = new Set(store.getLikedIds(likedCutoff).map(String));

  const candidates = [];
  let missingEmb = 0;
  let likedDropped = 0;
  for (const item of pool) {
    if (likedIds.has(item.id)) {
      likedDropped++;
      run.event('drop', { id: item.id, reason: 'liked' }, 'detail');
      continue;
    }
    const emb = embById.get(item.id);
    if (!emb) {
      missingEmb++;
      run.event('drop', { id: item.id, reason: 'missing_embedding' }, 'detail');
      continue;
    }
    // Filter out items published after the given date (look-ahead prevention)
    const pubDate = item.published ? Date.parse(item.published) : null;
    if (pubDate && pubDate > now.getTime()) {
      run.event('drop', { id: item.id, reason: 'future_published' }, 'detail');
      continue;
    }
    // Encode features
    const ctx = { interests, authorCfg: cfg.authors };
    const { keys, vals } = encode({ ...item, vec: assertVec(emb.vec, dim, item.id) }, ctx, cfg.features);
    // Predict
    const pred = model.predict(keys, vals);
    // Nearest cluster
    const { cid } = topDistances(interests, emb.vec, 1)[0];
    const core = interests.clusters[cid]?.core ?? false;
    // Age in days
    const firstSeen = item.first_seen ? Date.parse(item.first_seen) : null;
    const ageDays = Math.max(0, (now - (pubDate || firstSeen || now)) / 86400000);
    // Days since shown
    let daysSinceShown = null;
    const last = lastShown.get(item.id);
    if (last) {
      daysSinceShown = (Date.parse(dateKey + 'T00:00:00.000Z') - Date.parse(last)) / 86400000;
      if (daysSinceShown < 0) daysSinceShown = 0;
    }
    
    if (run.want('detail')) {
      run.event('candidate', {
        id: item.id,
        mu: pred.mu,
        var: pred.var,
        p: pred.p,
        unknownKeys: keys.filter((k) => !model.featureIndex.has(k)),
        cluster: cid,
        core,
        publishedAgeDays: pubDate === null ? null : (now - pubDate) / 86400000,
        firstSeenAgeDays: firstSeen === null ? null : (now - firstSeen) / 86400000,
        daysSinceShown,
        contributions: model.explain(keys, vals).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 5),
      }, 'detail');
    }
    candidates.push({
      id: item.id,
      title: item.title,
      source_type: item.source_type,
      p: pred.p,
      age_days: ageDays,
      days_since_shown: daysSinceShown,
      times_shown: item.times_shown ?? 0,
      cluster: cid,
      core,
    });
  }
  if (missingEmb > 0) console.error(`[prepareCandidates] ${missingEmb} pool items missing embeddings, skipped`);
  if (likedDropped > 0) console.error(`[prepareCandidates] ${likedDropped} pool items dropped (liked/saved)`);
  run.event('candidates', { pool: pool.length, candidates: candidates.length, missingEmb, likedDropped });
  return candidates;
}

/**
 * Evaluate model on chronological holdout.
 * Returns AUC and logLoss for: prior-only, keyword rel, fitted model.
 * @param {import('./store.js').Store} store
 * @param {object} cfg - config.ranker
 * @param {{testFrac?: number, cutoffDate?: string}} opts
 */
export async function evalModel(store, cfg, { testFrac = 0.2, cutoffDate = null, run = NULL_RUN } = {}) {
  const { dim } = embeddingOf(cfg);
  // Load perfect samples
  let perfectSamples = [];
  try {
    const { readFileSync } = await import('node:fs');
    perfectSamples = JSON.parse(readFileSync(cfg.perfect_samples_file || 'perfect_samples.json', 'utf8'));
  } catch {
    console.error('[eval] no perfect_samples.json found');
  }

  const trainingRows = store.getTrainingRows(cutoffDate);
  const allEmbeddings = store.getAllEmbeddings();
  const embById = new Map(allEmbeddings.map((e) => [e.item_id, e]));
  // Eval split: interests only see likes made before the chronological cut
  const cut = chronoCut(trainingRows.filter((r) => embById.has(r.item_id)).map((r) => r.date), testFrac);
  const likedIds = store.getLikedWithDates(cfg.interests.maxLikedDays)
    .filter((l) => l.liked_date < cut)
    .map((l) => l.item_id);
  console.error(`[eval] cut=${cut} liked before cut=${likedIds.length}`);

  // Build perfect samples with vectors
  const perfectWithVecs = [];
  for (const ps of perfectSamples) {
    const rawId = ps.id;
    const id = rawId.startsWith('ps:') ? rawId : `ps:${rawId}`;
    const emb = store.getEmbedding(id);
    if (emb) {
      const representative = ps.representative ?? true;
      if (ps.representative === undefined) {
        console.error(`[eval] WARNING: perfect sample ${id} missing 'representative' field, defaulting to true`);
      }
      perfectWithVecs.push({ id, vec: assertVec(emb.vec, dim, id), core: ps.core, representative });
    }
  }

  // Get liked items with vectors
  const likedWithVecs = [];
  for (const lid of likedIds) {
    const emb = embById.get(lid);
    if (emb) likedWithVecs.push({ id: lid, vec: assertVec(emb.vec, dim, lid) });
  }

  // Build training examples (cross-fitted for fitted model, full interests for keyword rel baseline)
  const vecs = new Map([...embById.entries()].map(([k, v]) => [k, v.vec]));
  const { examples, full: interests } = buildTrainingSet({
    perfect: perfectWithVecs,
    liked: likedWithVecs,
    rows: trainingRows,
    vecs,
    cfg,
  });

  if (examples.length === 0) {
    console.error('[eval] no training examples with embeddings');
    return { cut, nTrain: 0, nTest: 0, prior: { auc: NaN, logLoss: NaN }, keyword: { auc: NaN, logLoss: NaN }, fitted: { auc: NaN, logLoss: NaN } };
  }

  // Chronological split
  const { train, test } = chronoSplit(examples, testFrac);
  console.error(`[eval] train=${train.length} test=${test.length} (testFrac=${testFrac})`);

  // Get pool items for scaling and for keyword baseline (rel scores)
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

  // --- Baseline 1: Prior only (model with no fit, just priors) ---
  const PriorModelClass = MODELS[cfg.model?.name ?? 'bayes_lr'] ?? SparseBayesLogReg;
  const priorModel = new PriorModelClass(cfg.model);
  // Don't fit, just use priors (non-Bayesian models start at zero weights = prior mean 0)

  // --- Baseline 2: Keyword rel ---
  // Use the 'rel' score from candidate_pool as the prediction
  const keywordScores = [];
  const keywordLabels = [];
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

  // Evaluate all three
  function evaluate(model, testSet) {
    const scores = [];
    const labels = [];
    for (const ex of testSet) {
      const pred = model.predict(ex.keys, ex.vals);
      scores.push(pred.p);
      labels.push(ex.y);
    }
    return { auc: auc(scores, labels), logLoss: logLoss(scores, labels) };
  }

  const priorResults = evaluate(priorModel, test);
  const fittedResults = evaluate(fittedModel, test);

  console.error(`[eval] Prior: AUC=${priorResults.auc?.toFixed(4) ?? 'NaN'} logLoss=${priorResults.logLoss?.toFixed(4) ?? 'NaN'}`);
  console.error(`[eval] Keyword: AUC=${keywordResults.auc?.toFixed(4) ?? 'NaN'} logLoss=${keywordResults.logLoss?.toFixed(4) ?? 'NaN'}`);
  console.error(`[eval] Fitted: AUC=${fittedResults.auc?.toFixed(4) ?? 'NaN'} logLoss=${fittedResults.logLoss?.toFixed(4) ?? 'NaN'}`);

  return { cut, nTrain: train.length, nTest: test.length, prior: priorResults, keyword: keywordResults, fitted: fittedResults };
}