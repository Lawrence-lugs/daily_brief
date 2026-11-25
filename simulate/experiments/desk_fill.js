// Offline desk-filling comparisons. Each variant and seed owns its exposure history.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { encode } from '../../ranker/features.js';
import { journalFrontMatter } from '../../ranker/journal.js';
import { buildTrainingSet } from '../../ranker/trainer.js';
import { nearest } from '../../ranker/interests.js';
import { MODELS, auc, logLoss } from '../../ranker/model.js';
import { embeddingOf, textHash, textOf } from '../../ranker/embedder.js';
import { fromBlob } from '../../ranker/vec.js';
import { ageUnits, cadenceFor, cadenceMapFromSources } from '../../ranker/age.js';
import { mulberry32, selectBrief } from '../../ranker/sampler.js';
import { DEFAULTS, greedyScore, pickDesk } from '../../server/lib/selection.js';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const dayOf = value => Date.parse(value) / 86400000;
const iso = day => new Date(day * 86400000).toISOString().slice(0, 10);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function overlay(base, patch) {
  if (!object(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = overlay(base?.[key], value);
  return out;
}
function integer(value, key, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) throw Error('Invalid ' + key);
  return value;
}
function date(value) {
  const d = dayOf(value);
  if (!Number.isFinite(d) || iso(d) !== value) throw Error('Expected YYYY-MM-DD, got ' + value);
  return d;
}

function readSnapshot(path, desks, needVectors) {
  const db = new DatabaseSync(path, { readOnly: true });
  const all = sql => db.prepare(sql).all();
  try {
    db.exec('BEGIN');
    const pool = all('SELECT p.*, m.authors FROM candidate_pool p LEFT JOIN item_meta m USING(item_id) ORDER BY item_id')
      .map(r => ({ ...r, id: r.item_id, seen: dayOf(r.first_seen), pub: dayOf(r.published || r.first_seen),
        authors: JSON.parse(r.authors ?? '[]') }));
    const history = all(`SELECT s.item_id, s.desk, s.position, s.mode, s.source_type, s.source, s.rel,
      b.brief_id, b.date, b.generated_at FROM stories s JOIN briefs b USING(brief_id)
      ORDER BY b.date, b.generated_at, b.brief_id, s.position`).filter(r => desks.includes(r.desk));
    const feedback = new Map(all(`SELECT item_id, min(day) AS day FROM (
      SELECT item_id, date(liked_at) AS day FROM likes UNION ALL SELECT item_id, date(saved_at) FROM saves
    ) GROUP BY item_id`).map(r => [r.item_id, date(r.day)]));
    const embeddings = needVectors ? all('SELECT item_id, text_hash, model, dim, vec FROM embeddings') : [];
    const editions = new Set(history.map(r => r.brief_id));
    const rejects = all('SELECT brief_id, date, rejected_ids FROM briefs ORDER BY date').filter(r => editions.has(r.brief_id));
    return { pool, byId: new Map(pool.map(r => [r.id, r])), history, feedback, embeddings, rejects };
  } finally {
    db.close();
  }
}

function planWindows(spec, data) {
  const stamps = data.pool.map(r => Math.floor(r.seen)).concat(data.history.map(r => date(r.date))).filter(Number.isFinite);
  if (!stamps.length && !spec.end) return [];
  const last = spec.end ? date(spec.end) : stamps.reduce((a,b) => Math.max(a,b));
  const width = integer(spec.windowDays ?? 3, 'windowDays');
  const count = integer(spec.windows ?? 2, 'windows');
  const first = spec.start ? date(spec.start) : Math.max(last - width * count + 1,
    stamps.length ? stamps.reduce((a,b)=>Math.min(a,b)) : last);
  if (first > last) throw Error('start must precede or equal end');
  const windows = [];
  for (let start = first; start <= last; start += width) windows.push({ start, end: Math.min(start + width - 1, last), frozen: false });
  const drought = integer(spec.droughtDays ?? 7, 'droughtDays', 0);
  if (drought) windows.push({ start: last + 1, end: last + drought, frozen: true });
  return windows;
}

function defaultVariants(config) {
  if ((config.ranker?.engine ?? 'keyword') === 'keyword') return [
    { name: 'configured' }, { name: 'lighter-repeat', selection: { shown_decay: .8 } },
  ];
  const sampling = config.ranker.sampling;
  const target = Object.keys(sampling.slowDesks ?? {});
  const desks = target.length ? target : Object.keys(config.desks);
  const policies = Object.fromEntries(desks.map(d => [d, {
    ...sampling.slowDesks?.[d], minValue: .12, repeatWeight: .8, rollover: true,
  }]));
  const hasFeed = config.ranker.features.includes('feed');
  return [
    { name: 'configured' },
    { name: 'cluster-round-robin', sampling: { slowDesks: null } },
    { name: 'top-decile', topFraction: .1, targetDesks: desks, sampling: { slowDesks: null } },
    { name: 'top-100', topK: 100, targetDesks: desks, sampling: { slowDesks: null } },
    { name: 'rolling', sampling: { slowDesks: policies } },
    { name: hasFeed ? 'without-feed' : 'with-feed', features: hasFeed
      ? config.ranker.features.filter(f => f !== 'feed') : [...config.ranker.features, 'feed'] },
  ];
}

// Expand a base variant over independent settings. Arrays are values, so a
// grid can sweep entire feature lists or prior-rule lists as well as numbers.
function expandVariants(bases) {
  return bases.flatMap(({ grid = {}, ...base }) => {
    let cases = [base];
    for (const [path, values] of Object.entries(grid)) {
      const parts = path.split('.');
      if (!['model','sampling','selection','features','priorRules','topK','topFraction'].includes(parts[0]) ||
          parts.some(p => !p || ['constructor','prototype','__proto__'].includes(p))) throw Error('Invalid grid path: ' + path);
      if (!Array.isArray(values) || !values.length) throw Error('Empty grid axis: ' + path);
      cases = cases.flatMap(v => values.map(value => {
        const patch = parts.reduceRight((node, key) => ({ [key]: node }), value);
        return { ...overlay(v, patch), name: v.name + ' ' + path + '=' + JSON.stringify(value) };
      }));
    }
    return cases;
  });
}

function fit(config, variant, data, before, start, anchors, vectors) {
  const cfg = overlay(config.ranker, { model: variant.model ?? {}, features: variant.features ?? config.ranker.features });
  if (variant.priorRules) {
    if (cfg.model.name !== 'bayes_lr') throw Error('priorRules require the Bayesian LR model');
    cfg.model = { ...cfg.model, prior: { ...cfg.model.prior, rules: [...(cfg.model.prior.rules ?? []), ...variant.priorRules] } };
  }
  const rows = [...new Map(before.map(r => [r.item_id, {
    ...data.byId.get(r.item_id), ...r, y: Number(data.feedback.get(r.item_id) < start),
  }])).values()];
  const liked = rows.filter(r => r.y && vectors.has(r.item_id) &&
    data.feedback.get(r.item_id) >= start - (cfg.interests.maxLikedDays ?? Infinity))
    .map(r => ({ id: r.item_id, vec: vectors.get(r.item_id) }));
  if (!anchors.length && !liked.length) return { items: [], training: 0, reason: 'no historical interest anchors' };
  const { examples, full } = buildTrainingSet({ perfect: anchors, liked, rows, vecs: vectors, cfg });
  const encoded = data.pool.filter(r => vectors.has(r.id)).map(r => {
    const vec = vectors.get(r.id);
    const { cid } = nearest(full, vec);
    return { ...r, ...encode({ ...r, vec }, { interests: full, authorCfg: cfg.authors }, cfg.features),
      desk: full.clusters[cid].desk, cluster: cid };
  });
  const Model = MODELS[cfg.model?.name ?? 'bayes_lr'];
  if (!Model) throw Error('Unknown scoring model: ' + cfg.model.name);
  const model = new Model(cfg.model);
  if (examples.length) model.fit(examples, { scaleSample: encoded.filter(r => r.seen < start && r.pub < start) });
  const items = encoded.map(r => ({ ...r, p: model.predict(r.keys, r.vals).p,
    notice: cfg.features.includes('journal') && journalFrontMatter(r) }));
  return { items, training: examples.length };
}

function validation(items, before, history, feedback, window) {
  if (window.frozen) return null;
  const seen = new Set(before.map(r => r.item_id));
  const held = new Set(history.filter(r => date(r.date) >= window.start && date(r.date) <= window.end && !seen.has(r.item_id)).map(r => r.item_id));
  const test = items.filter(r => held.has(r.id));
  const y = test.map(r => Number(feedback.get(r.id) <= window.end));
  const p = test.map(r => r.p);
  return { scored: y.length, positives: y.filter(Boolean).length, auc: y.includes(1) && y.includes(0) ? auc(p,y) : null,
    logLoss: y.length ? logLoss(p,y) : null };
}

function shortlist(items, variant, desks, sampling) {
  if (!variant.topK && !variant.topFraction) return items;
  const targets = variant.targetDesks ?? desks;
  const kept = items.filter(r => !targets.includes(r.desk));
  for (const desk of targets) {
    const eligible = items.filter(r => r.desk === desk && (r.days_since_shown == null ||
      r.days_since_shown >= sampling.dedupe.hardWindowDays ||
      (sampling.slowDesks?.[desk]?.rollover && r.previousDesk === desk))).sort((a,b) => b.p - a.p);
    kept.push(...eligible.slice(0, variant.topK ?? Math.ceil(eligible.length * variant.topFraction)));
  }
  return kept;
}

function replay(config, variant, fitted, data, window, before, seeds, cadence, reviews, labels) {
  const desks = Object.keys(config.desks);
  const isLR = (config.ranker?.engine ?? 'keyword') === 'lr';
  const slots = config.stories_per_desk ?? 5;
  const sampling = { ...overlay(config.ranker?.sampling, variant.sampling ?? {}), stories_per_desk: slots, reserve_per_desk: 0 };
  const selection = { ...DEFAULTS, ...config.selection, ...variant.selection };
  const stats = Object.fromEntries(desks.map(d => [d, { slots: 0, filled: 0, repeats: 0, distinct: new Set(),
    greedy: 0, explore: 0, greedyValueSum: 0, greedyBelowPointOne: 0, judgedGreedy: 0, relevantGreedy: 0, sources: {} }]));
  const rejected = new Map();
  for (const r of data.rejects.filter(r => date(r.date) < window.start)) {
    for (const id of JSON.parse(r.rejected_ids || '[]')) rejected.set(id, (rejected.get(id) ?? 0) + 1);
  }
  const sample = [];
  for (const seed of seeds) {
    const shown = new Map();
    for (const r of before) shown.set(r.item_id, { last: dayOf(r.generated_at), count: (shown.get(r.item_id)?.count ?? 0) + 1 });
    let previous = new Map(before.filter(r => r.brief_id === before.at(-1)?.brief_id && r.mode === 'greedy').map(r => [r.item_id,r]));
    for (let day = window.start; day <= window.end; day++) {
      const now = day + .5;
      const items = [];
      for (const r of fitted.items) {
        if (window.frozen && (r.seen >= window.start || r.pub >= window.start)) continue;
        if (!(r.seen <= now && r.pub <= now) || now - r.pub > (config.pool?.max_age_days ?? Infinity) || r.notice) continue;
        if (data.feedback.get(r.id) < (window.frozen ? window.start : day)) continue;
        const rec = shown.get(r.id);
        items.push({ ...r, rejected: rejected.get(r.id) ?? 0, days_since_shown: rec ? Math.max(0,day-rec.last) : null,
          times_shown: rec?.count ?? 0, previousDesk: previous.get(r.id)?.desk, previousPosition: previous.get(r.id)?.position,
          age_days: now-r.pub, age_units: ageUnits(now-r.pub, cadenceFor(cadence,r.feed ?? r.source)) });
      }
      const rng = mulberry32(Math.imul(day, 0x9e3779b1) ^ seed);
      const picks = isLR ? selectBrief(shortlist(items, variant, desks, sampling), sampling, rng) : Object.fromEntries(desks.map(d => {
        const topics = config.desks[d]['keyword-model-subtopics'] ?? config.desks[d].subtopics ?? [];
        return [d, pickDesk(items, topics, slots, selection, rng, { newslike: 1, paperlike: 2 })
          .map(([r,mode]) => ({ ...r, mode, V: greedyScore(r,selection) }))];
      }));
      previous = new Map();
      for (const desk of desks) {
        const s = stats[desk];
        s.slots += slots;
        for (const [position, r] of (picks[desk] ?? []).entries()) {
          s.filled++; s[r.mode]++; s.distinct.add(r.id);
          const feed = r.feed || r.source;
          s.sources[feed] = (s.sources[feed] ?? 0) + 1;
          if (shown.has(r.id)) s.repeats++;
          shown.set(r.id, { last: now, count: (shown.get(r.id)?.count ?? 0) + 1 });
          const key = JSON.stringify([desk,r.id]);
          if (r.mode === 'greedy') {
            s.greedyValueSum += r.V;
            if (r.V < .1) s.greedyBelowPointOne++;
            previous.set(r.id, { desk, position });
            if (labels.has(key)) { s.judgedGreedy++; s.relevantGreedy += Number(labels.get(key)); }
          }
          reviews.set(key, { desk, id:r.id, title:r.title, source:feed, relevant:labels.get(key) ?? null });
          if (seed === seeds[0]) sample.push({ date:iso(day), desk, position, id:r.id, title:r.title, mode:r.mode, V:r.V, p:r.p });
        }
      }
    }
  }
  for (const s of Object.values(stats)) {
    s.distinct = s.distinct.size;
    s.meanGreedyValue = s.greedy ? s.greedyValueSum / s.greedy : null;
    delete s.greedyValueSum;
    s.fillRate = s.slots ? s.filled / s.slots : null;
    s.directFitRate = s.judgedGreedy ? s.relevantGreedy / s.judgedGreedy : null;
  }
  return { stats, sample };
}

export function runDeskFill({ db, config: configPath, sources, samples, spec = {}, judgments = [] }) {
  const config = json(configPath);
  const dir = dirname(configPath);
  const desks = Object.keys(config.desks ?? {});
  if (!desks.length) throw Error('config.desks must name at least one desk');
  const cadence = cadenceMapFromSources(json(sources ?? resolve(dir,'sources.json')));
  const isLR = (config.ranker?.engine ?? 'keyword') === 'lr';
  const data = readSnapshot(db, desks, isLR);
  if (spec.feeds) {
    if (!Array.isArray(spec.feeds)) throw Error('feeds must be an array of stored feed or source names');
    const allow = new Set(spec.feeds);
    data.pool = data.pool.filter(r => allow.has(r.feed || r.source));
  }
  const seeds = spec.seeds ?? [1,2,3,4];
  if (!Array.isArray(seeds) || !seeds.length || new Set(seeds).size !== seeds.length) throw Error('seeds must be a nonempty list of distinct integers');
  seeds.forEach(s => integer(s,'seed',0));
  const variants = expandVariants(spec.variants ?? defaultVariants(config));
  if (!Array.isArray(variants) || !variants.length || variants.some(v => !v.name) ||
      new Set(variants.map(v => v.name)).size !== variants.length) throw Error('Supply uniquely named variants');
  for (const v of variants) {
    if (v.topK !== undefined) integer(v.topK, 'topK');
    if (v.topFraction !== undefined && !(v.topFraction > 0 && v.topFraction <= 1)) throw Error('topFraction must be in (0,1]');
    if (v.topFraction && v.topK) throw Error('Choose one shortlist limit');
    if (v.targetDesks?.some(d => !desks.includes(d))) throw Error('Unknown target desk');
    if (!isLR && (v.topFraction || v.topK || v.model || v.features || v.priorRules || v.sampling)) throw Error('Keyword variants use selection overrides');
    if (isLR && v.selection) throw Error('LR variants use sampling overrides');
  }
  const reviews = new Map();
  const labels = new Map();
  for (const r of judgments) {
    if (r.relevant === null) continue;
    if (!desks.includes(r.desk) || !r.id || typeof r.relevant !== 'boolean') throw Error('Invalid desk/item judgment');
    const key = JSON.stringify([r.desk,r.id]);
    if (labels.has(key)) throw Error('Duplicate judgment for ' + key);
    labels.set(key,r.relevant);
  }
  const windows = planWindows(spec,data);
  let anchors = [], vectors = new Map();
  if (isLR && windows.length) {
    const embedding = embeddingOf(config.ranker);
    const cached = new Map(data.embeddings.filter(r => r.model === embedding.tag && r.dim === embedding.dim).map(r => [r.item_id,r]));
    vectors = new Map([...cached].map(([id,r]) => [id, fromBlob(r.vec)]));
    anchors = json(samples ?? resolve(dir,config.ranker.perfect_samples_file ?? 'perfect_samples.json')).map(s => {
      const id = s.id.startsWith('ps:') ? s.id : 'ps:' + s.id;
      if (cached.get(id)?.text_hash !== textHash(textOf(s.title,s.snippet))) throw Error('Missing or mismatched cached anchor ' + id + ' for ' + embedding.tag + '. Use the matching profile and fitted database.');
      return { ...s, representative:s.representative ?? true, id, vec:vectors.get(id) };
    });
  }
  const results = windows.map(window => {
    const before = data.history.filter(r => date(r.date) < window.start);
    const models = new Map();
    const runs = variants.map(v => {
      const key = JSON.stringify([v.model,v.features,v.priorRules]);
      if (!models.has(key)) models.set(key,isLR ? fit(config,v,data,before,window.start,anchors,vectors) : { items:data.pool, training:0 });
      const fitted = models.get(key);
      return { variant:v.name, training:fitted.training, reason:fitted.reason,
        validation:isLR ? validation(fitted.items,before,data.history,data.feedback,window) : null,
        ...replay(config,v,fitted,data,window,before,seeds,cadence,reviews,labels) };
    });
    return { start:iso(window.start), end:iso(window.end), frozen:window.frozen, runs };
  });
  return { version:1, spec, cadenceByFeed:Object.fromEntries(cadence), engine:config.ranker?.engine ?? 'keyword', desks, seeds, variants, pool:data.pool.length,
    missingCandidateVectors:isLR ? data.pool.filter(r => !vectors.has(r.id)).length : null,
    windows:results, review:[...reviews.values()].sort((a,b) => a.desk.localeCompare(b.desk) || a.id.localeCompare(b.id)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = Object.fromEntries(['db','config','sources','samples','spec','judgments','out'].map(k => [k,{ type:'string' }]));
  const { values } = parseArgs({ options });
  if (!values.db || !values.config) throw Error('Usage: desk_fill.js --db FILE --config FILE [--sources FILE] [--samples FILE] [--spec FILE] [--judgments FILE] [--out FILE]');
  const labels = values.judgments ? json(values.judgments) : [];
  const result = runDeskFill({ ...values, spec:values.spec ? json(values.spec) : {}, judgments:labels.review ?? labels });
  const content = JSON.stringify(result,null,2) + '\n';
  if (values.out) writeFileSync(values.out,content,{ flag:'wx' }); else process.stdout.write(content);
}
