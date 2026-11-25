// Offline walk-forward replay. Run from repo root. Uses only cached vectors.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '../../ranker/features.js';
import { circuitJournal, journalFrontMatter } from '../../ranker/journal.js';
import { buildTrainingSet } from '../../ranker/trainer.js';
import { topDistances } from '../../ranker/interests.js';
import { SparseBayesLogReg, auc, logLoss } from '../../ranker/model.js';
import { textOf, textHash } from '../../ranker/embedder.js';
import { fromBlob } from '../../ranker/vec.js';
import { ageUnits, cadenceFor, cadenceMapFromSources } from '../../ranker/age.js';
import { selectBrief, mulberry32 } from '../../ranker/sampler.js';

const [dbFile, dir = 'user/ulab_settings', sourceFile = 'user/defaults/sources.json'] = process.argv.slice(2);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const config = json(join(dir, 'config.json'));
const cfg = config.ranker;
const db = new DatabaseSync(dbFile, { readOnly: true });
const all = sql => db.prepare(sql).all();
const embeddings = new Map(all('SELECT item_id, vec, text_hash FROM embeddings').map(r => [r.item_id, r]));
const vecs = new Map([...embeddings].map(([id, r]) => [id, fromBlob(r.vec)]));
const perfect = json(join(dir, 'perfect_samples.json')).map(s => {
  const id = 'ps:' + s.id;
  if (embeddings.get(id)?.text_hash !== textHash(textOf(s.title, s.snippet))) throw Error('anchor mismatch: ' + id);
  return { ...s, id, vec: vecs.get(id) };
});
const pool = all('SELECT p.*, m.authors FROM candidate_pool p LEFT JOIN item_meta m USING(item_id) ORDER BY item_id')
  .filter(r => vecs.has(r.item_id)).map(r => ({ ...r, id: r.item_id, authors: JSON.parse(r.authors ?? '[]') }));
const byId = new Map(pool.map(r => [r.id, r]));
const history = all('SELECT s.item_id, s.desk, s.source, s.source_type, s.mode, s.position, b.brief_id, b.date, b.generated_at FROM stories s JOIN briefs b USING(brief_id) ORDER BY b.date, s.story_id');
const feedback = new Map(all(`SELECT item_id, min(day) AS day FROM (
  SELECT item_id, date(liked_at) AS day FROM likes UNION ALL SELECT item_id, date(saved_at) FROM saves
) GROUP BY item_id`).map(r => [r.item_id, r.day]));
const cadence = cadenceMapFromSources(json(sourceFile));
const sampling = { ...cfg.sampling, stories_per_desk: config.stories_per_desk, reserve_per_desk: 0 };
const slow = Object.keys(sampling.slowDesks);
const features = [...new Set([...cfg.features, 'journal'])];
const days = date => Date.parse(date) / 86400000;
const dateAt = day => new Date(day * 86400000).toISOString().slice(0, 10);
const output = [];
for (const [start, end] of [['2026-11-16','2026-11-19'], ['2026-11-20', '2026-11-22'], ['2026-11-23', '2026-11-25'], ['2026-11-26', '2026-12-09']]) {
  // Train the MicroLab reader only. Pool metadata is merged; desk labels from the other deployment differ.
  const web = history.filter(r => Object.hasOwn(config.desks, r.desk));
  const before = web.filter(r => r.date < start);
  const rows = [...new Map(before.map(r => [r.item_id, { ...byId.get(r.item_id), ...r,
    y: Number(feedback.get(r.item_id) < start) }])).values()];
  const liked = rows.filter(r => r.y && vecs.has(r.item_id)).map(r => ({ id: r.item_id, vec: vecs.get(r.item_id) }));
  const { examples, full } = buildTrainingSet({ perfect, liked, rows, vecs, cfg: { ...cfg, features } });
  const encoded = pool.map(r => {
    const vec = vecs.get(r.id);
    const { cid } = topDistances(full, vec, 1)[0];
    return { ...r, ...encode({ ...r, vec }, { interests: full, authorCfg: cfg.authors }, features),
      desk: full.clusters[cid].desk, cluster: cid };
  });
  const initial = new Map();
  for (const r of before) {
    initial.set(r.item_id, { last: days(r.generated_at), count: (initial.get(r.item_id)?.count ?? 0) + 1 });
  }
  const scoredByModel = new Map();
  const validation = [];
  const baselinePrior = structuredClone(cfg.model.prior);
  baselinePrior.rules = baselinePrior.rules.filter(r => !['circuitJournal', 'journal:'].includes(r.match));
  const grid = [[null, 1], [0, 1], [0, 4], [1, 1], [1, 4], [2, 1], [2, 4],
    [1, 1, 0.25], [1, 1, 4]];
  for (const [mean, precision, distancePrecision] of grid) {
    const prior = structuredClone(baselinePrior);
    if (mean !== null) prior.rules.push({ match: 'circuitJournal', mean, prec: precision }, { match: 'journal:', prec: 4 });
    if (distancePrecision) prior.rules.find(rule => rule.match === 'n:d1').prec = distancePrecision;
    const row = r => {
      if (mean !== null) return r;
      const n = r.keys.filter(k => k !== 'circuitJournal' && !k.startsWith('journal:'));
      // Journal indicators are one-hot; preserve numeric and author values.
      return { ...r, keys: n, vals: r.vals.filter((_, i) => n.includes(r.keys[i])) };
    };
    const model = new SparseBayesLogReg({ ...cfg.model, prior });
    model.fit(examples.map(row), { scaleSample: encoded.filter(r => r.first_seen.slice(0,10) < start && (!r.published || days(r.published) < days(start))).map(row) });
    const scored = encoded.map(r => {
      const x = row(r);
      return { id: r.id, title: r.title, snippet: r.snippet, p: model.predict(x.keys, x.vals).p, cluster: r.cluster, desk: r.desk,
        seen: days(r.first_seen), published: days(r.published ?? r.first_seen), cadence: cadenceFor(cadence, r.feed),
        journal: !!circuitJournal(r), front: journalFrontMatter(r) };
    });
    const key = mean === null ? 'baseline' : [mean, precision, distancePrecision].filter(v => v != null).join('/');
    scoredByModel.set(key, scored);
    const testIds = new Set(web.filter(r => r.date >= start && r.date <= end && !initial.has(r.item_id)).map(r => r.item_id));
    const test = scored.filter(r => testIds.has(r.id));
    const ys = test.map(r => Number(feedback.get(r.id) <= end));
    const byDesk = Object.fromEntries(Object.keys(config.desks).map(d => {
      const ids = new Set(web.filter(r => r.desk === d && r.date >= start && r.date <= end).map(r => r.item_id));
      const items = test.filter(r => ids.has(r.id));
      const labels = items.map(r => Number(feedback.get(r.id) <= end));
      return [d, { n: labels.length, pos: labels.reduce((a,b)=>a+b,0),
        auc: labels.includes(1) && labels.includes(0) ? auc(items.map(r=>r.p), labels) : null }];
    }));
    validation.push({ key, byDesk, n: ys.length, pos: ys.reduce((a,b)=>a+b,0), auc: ys.includes(1) ? auc(test.map(r=>r.p),ys) : null, loss: logLoss(test.map(r=>r.p),ys) });
  }
  const scenarios = [
    ['baseline','baseline'], ['venue','1/1'], ['top10%','1/1'], ['top100','1/1'],
    ...[0.06, 0.12, 0.18].flatMap(f => [0.05, 0.5, 0.8].map(w => ['gate-' + f + '-' + w, '1/1', f, w])),
    ['no-title','1/1',0.12,0.8], ['carry','1/1',0.12,0.8], ['carry-half','1/1',0.12,0.5], ['carry-low','1/1',0.06,0.5], ['snippet','1/1',0.12,0.8], ['snippet-rotate','1/1',0.12,0.8], ['configured','1/1',0.12,0.8],
  ];
  const results = [];
  for (const [name, key, floor, weight] of scenarios) {
    if (start === '2026-11-16') continue;
    if (start === '2026-11-26' && !['baseline','carry','carry-half','carry-low','snippet','snippet-rotate','configured'].includes(name)) continue;
    const stats = {};
    const sample = [];
    const greedyExposures = {};
    for (let seed = 1; seed <= 8; seed++) {
      const shown = new Map(initial);
      let prev = new Map(before.filter(r => r.brief_id === before.at(-1)?.brief_id && r.mode === 'greedy').map(r => [r.item_id, r]));
      for (let day = days(start); day <= days(end); day++) {
        const today = dateAt(day);
        const available = scoredByModel.get(key).filter(r => r.seen <= day + .5 && r.published <= day + .5 && day + .5 - r.published <= config.pool.max_age_days &&
          !(feedback.get(r.id) < today) && !(key !== 'baseline' && r.front)).map(r => {
          const rec = shown.get(r.id);
          return { ...r, previousDesk: prev.get(r.id)?.desk, previousPosition: prev.get(r.id)?.position, times_shown: rec?.count ?? 0, days_since_shown: rec ? day - rec.last : null,
            age_units: ageUnits(day + .5 - r.published, r.cadence) };
        });
        let candidates = available;
        if (name.startsWith('top')) {
          const keep = new Set();
          for (const desk of slow) {
            const group = available.filter(c => c.desk === desk && (c.days_since_shown === null || c.days_since_shown >= sampling.dedupe.hardWindowDays)).sort((a,b)=>b.p-a.p);
            group.slice(0, name === 'top100' ? 100 : Math.ceil(group.length / 10)).forEach(c => keep.add(c.id));
          }
          candidates = available.filter(c => !slow.includes(c.desk) || keep.has(c.id));
        }
        const opts = { ...sampling, slowDesks: undefined };
        if (floor) opts.slowDesks = Object.fromEntries(slow.map(d => [d, { ...sampling.slowDesks[d], minValue: floor, repeatWeight: weight, rollover: (name.startsWith('carry') || name === 'snippet'), includeSnippet: name.startsWith('snippet'),
          titleTerms: name === 'no-title' ? [] : sampling.slowDesks[d].titleTerms }]));
        prev = new Map();
        if (name === 'configured') opts.slowDesks = sampling.slowDesks;
        const brief = selectBrief(candidates, opts, mulberry32(day * 100 + seed));
        for (const desk of Object.keys(config.desks)) {
          const s = stats[desk] ??= { slots:0, picks:0, greedy:0, journal:0, repeats:0, explore:0, weak:0, p:0, V:0 };
          s.slots += sampling.stories_per_desk;
          for (const c of brief[desk] ?? []) {
            if (c.mode === 'greedy') prev.set(c.id, { desk, position: brief[desk].indexOf(c) });
            s.picks++; s.p += c.p; s.V += c.V;
            if (c.mode === 'explore') s.explore++; else { s.greedy++; s.journal += Number(c.journal); s.weak += Number(c.V < .1); }
            if (shown.has(c.id)) s.repeats++;
            shown.set(c.id, { count:(shown.get(c.id)?.count ?? 0)+1, last:day + .5 });
            if (slow.includes(desk) && c.mode === 'greedy') {
              const counts = greedyExposures[desk] ??= {};
              counts[c.id] = (counts[c.id] ?? 0) + 1;
            }
            if (seed === 1 && slow.includes(desk)) sample.push({ today, desk, id:c.id, title:c.title, mode:c.mode, p:c.p, V:c.V });
          }
        }
      }
    }
    results.push({ name, stats, sample, greedyExposures });
  }
  output.push({ start, end, nTrain: examples.length, validation, results });
}
console.log(JSON.stringify(output));
