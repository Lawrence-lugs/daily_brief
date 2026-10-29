// Run: node --test ranker/ranker.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { wardCut, weightedMedoid } from './agglo.js';
import { buildInterests, topDistances } from './interests.js';
import { authorKey, authorKeys, encode } from './features.js';
import { SparseBayesLogReg, auc } from './model.js';
import { selectBrief, mulberry32 } from './sampler.js';
import { normalize } from './vec.js';

const v = (...a) => normalize(Float32Array.from(a));
// 3 tight blobs in 3-D
const blob = (c, n, rng) => Array.from({ length: n }, () => v(...c.map((x) => x + (rng() - 0.5) * 0.05)));
const rng = mulberry32(7);
const A = blob([1, 0, 0], 6, rng), B = blob([0, 1, 0], 6, rng), C = blob([0, 0, 1], 6, rng);

test('wardCut fixed-k recovers the blobs', () => {
  const { clusters } = wardCut([...A, ...B, ...C], new Set(), { minClusters: 3 });
  assert.equal(clusters.length, 3);
  for (const cl of clusters) assert.equal(new Set(cl.map((i) => Math.floor(i / 6))).size, 1);
});

test("'stop' halts before two representative samples share a cluster", () => {
  const X = [...A, ...B, ...C];
  const representative = new Set([0, 6]);                       // one in A, one in B
  const { clusters, stopHeight, heights } = wardCut(X, representative, { mode: 'stop' });
  assert.ok(stopHeight >= Math.max(...heights));         // merges are monotone: stopped at the first violating (highest so far) merge
  const cl0 = clusters.find((c) => c.includes(0)), cl6 = clusters.find((c) => c.includes(6));
  assert.notEqual(cl0, cl6);                             // never share a cluster
  assert.ok(clusters.length >= 2 && clusters.length <= 3);   // which blob C joins first is a tie
});

test("'constrained' keeps merging non-representative clusters past the first violation", () => {
  const X = [...A, ...B, ...C];
  const { clusters } = wardCut(X, new Set([0, 6]), { mode: 'constrained' });
  assert.equal(clusters.length, 2);                      // C joins A or B; A and B stay apart
});

test('cold start: only perfect samples => one cluster each, medoid = itself', () => {
  const perfect = [{ id: 'ps:1', vec: A[0], core: true, representative: true }, { id: 'ps:2', vec: B[0], core: false, representative: true }];
  const it = buildInterests(perfect, [], { kappa: 20, mode: 'stop' });
  assert.equal(it.clusters.length, 2);
  assert.deepEqual(it.clusters.map((c) => c.core).sort(), [false, true]);
});

test('perfect sample (weight 20) dominates its cluster medoid', () => {
  const perfect = [{ id: 'ps:1', vec: A[0], core: true, representative: true }];
  const liked = A.slice(1).map((vec, i) => ({ id: `l${i}`, vec }));
  const it = buildInterests(perfect, liked, { kappa: 20, mode: 'stop', minClusters: 1 });
  assert.equal(it.clusters.length, 1);
  assert.equal(it.clusters[0].medoid, 'ps:1');
});

test('non-representative perfect samples do not block clustering', () => {
  const X = [...A, ...B, ...C];
  // 0 in A, 6 in B are non-representative perfect samples; they should cluster freely
  // Only representative samples (none in this test) block merges
  const { clusters } = wardCut(X, new Set(), { mode: 'stop' });
  assert.equal(clusters.length, 1); // all merge into one
});

test('mixed: one representative blocks only other representatives', () => {
  const X = [...A, ...B, ...C];
  // 0 (in A) is representative, 6 (in B) is not
  // A and B CAN merge because only ONE of them has a representative sample
  // C can merge with A+B
  const { clusters } = wardCut(X, new Set([0]), { mode: 'stop' });
  // Since only 0 is representative, 6 (in B) is not blocked from merging with 0
  // So A and B merge, then C merges with A+B -> 1 cluster
  assert.equal(clusters.length, 1);
  // Verify that the representative sample 0 is in the cluster
  const cl0 = clusters.find((c) => c.includes(0));
  assert.ok(cl0 !== undefined);
});

test('non-representative perfect sample clusters with representative one', () => {
  // Non-rep perfect sample should be able to merge with a rep perfect sample
  const perfect = [
    { id: 'ps:rep', vec: A[0], core: true, representative: true },
    { id: 'ps:nonrep', vec: A[1], core: false, representative: false },
    { id: 'ps:other', vec: B[0], core: true, representative: true },
  ];
  const it = buildInterests(perfect, [], { kappa: 20, mode: 'stop' });
  // rep samples (0 and 2) must be in different clusters
  // non-rep (1) can merge with either
  assert.equal(it.clusters.length, 2);
  const clRep1 = it.clusters.find((c) => c.members.includes('ps:rep'));
  const clRep2 = it.clusters.find((c) => c.members.includes('ps:other'));
  assert.notEqual(clRep1, clRep2);
  // non-rep should be in one of the two clusters
  const nonRepCluster = it.clusters.find((c) => c.members.includes('ps:nonrep'));
  assert.ok(nonRepCluster === clRep1 || nonRepCluster === clRep2);
});

test('single representative sample never blocks (no other rep to conflict)', () => {
  const X = [...A, ...B, ...C];
  const { clusters } = wardCut(X, new Set([0]), { mode: 'stop' });
  // Only one rep -> no conflict possible -> all merge into 1
  assert.equal(clusters.length, 1);
});

test('all perfect samples non-representative => no blocking', () => {
  // This is equivalent to empty representative set
  const X = [...A, ...B, ...C];
  const { clusters } = wardCut(X, new Set(), { mode: 'stop' });
  assert.equal(clusters.length, 1);
});

test('constrained mode: multiple representatives in same cluster block merge with other rep cluster', () => {
  // Two reps in A, one in B -> A and B must stay separate
  const X = [...A, ...B, ...C];
  const { clusters } = wardCut(X, new Set([0, 1, 6]), { mode: 'constrained' });
  // A has 2 reps (0,1), B has 1 rep (6) -> they block each other
  // C can join either
  const cl0 = clusters.find((c) => c.includes(0));
  const cl6 = clusters.find((c) => c.includes(6));
  assert.notEqual(cl0, cl6);
  assert.ok(clusters.length === 2 || clusters.length === 3); // C joins A or B, or stays separate
});

test('constrained mode: non-rep clusters merge freely, but rep cluster can absorb them', () => {
  // Rep at 0 (A), non-rep clusters B and C -> A can merge with B and C since they have no reps
  const X = [...A, ...B, ...C];
  const { clusters } = wardCut(X, new Set([0]), { mode: 'constrained' });
  // In constrained mode, a cluster WITH a rep CAN merge with a cluster WITHOUT a rep
  // So A merges with B, then (A+B) merges with C -> 1 cluster
  assert.equal(clusters.length, 1);
  const cl0 = clusters.find((c) => c.includes(0));
  assert.ok(cl0 !== undefined);
  assert.ok(cl0.includes(7)); // B merged in
  assert.ok(cl0.includes(13)); // C merged in
});

test('topDistances is ascending and padded', () => {
  const it = buildInterests([{ id: 'p', vec: A[0], core: true }], [], { kappa: 20 });
  const d = topDistances(it, B[0], 3);
  assert.equal(d.length, 3);
  assert.ok(d[0].d <= d[1].d && d[1].d <= d[2].d);
});

test('authorKey handles abbreviations and "Last, First"', () => {
  assert.equal(authorKey('John Smith'), 'smith|j');
  assert.equal(authorKey('J. Smith'), 'smith|j');
  assert.equal(authorKey('Smith, John'), 'smith|j');
  assert.equal(authorKey('Étienne Müller'), 'muller|e');
  assert.equal(authorKeys(['a b', 'c d', 'e f', 'g h', 'i j', 'k l']).length, 5);   // >5 -> first 3 + last 2
  assert.equal(authorKeys(['a b', 'c d', 'e f']).length, 3);
});

test('encode merges and names features', () => {
  const it = buildInterests([{ id: 'p', vec: A[0], core: true }], [], { kappa: 20 });
  const { keys } = encode({ source_type: 'paperlike', authors: ['A B'], vec: A[1] }, { interests: it }, ['bias', 'type', 'author', 'medoid']);
  assert.deepEqual(keys, ['b', 't:paperlike', 'a:b|a', 'n:d1', 'n:d2', 'n:d3']);
});

const PRIOR = { default: { prec: 1, mean: 0 }, rules: [{ match: 'b', prec: 0.5, mean: -1 }, { match: 'a:', prec: 3 }] };

test('model learns a liked author and ranks it above an unseen one', () => {
  const r = mulberry32(3), ex = [];
  for (let i = 0; i < 300; i++) {
    const good = r() < 0.4;
    const keys = ['b', good ? 'a:good|x' : 'a:bad|x'], vals = [1, 1];
    ex.push({ keys, vals, y: r() < (good ? 0.8 : 0.1) ? 1 : 0 });
  }
  const m = new SparseBayesLogReg({ prior: PRIOR }).fit(ex);
  const pg = m.predict(['b', 'a:good|x'], [1, 1]).p, pb = m.predict(['b', 'a:bad|x'], [1, 1]).p;
  const pu = m.predict(['b', 'a:new|x'], [1, 1]).p;
  assert.ok(pg > 0.6 && pb < 0.25, `${pg} ${pb}`);
  assert.ok(pu > pb && pu < pg);
  const m2 = SparseBayesLogReg.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), { prior: PRIOR });
  assert.ok(Math.abs(m2.predict(['b', 'a:good|x'], [1, 1]).p - pg) < 1e-9);
});

test('model with zero data == its prior (cold start), numeric feature gets prior slope', () => {
  const prior = { default: { prec: 1, mean: 0 }, rules: [{ match: 'n:d1', prec: 1, mean: -1 }] };
  const m = new SparseBayesLogReg({ prior, numDefault: { mean: 0.5, std: 0.1 } }).fit([]);
  assert.ok(m.predict(['n:d1'], [0.3]).p > m.predict(['n:d1'], [0.7]).p);
});

test('numeric z-scoring + recovery of a negative slope', () => {
  const r = mulberry32(11), ex = [];
  for (let i = 0; i < 400; i++) { const d = 0.2 + r() * 0.6; ex.push({ keys: ['b', 'n:d1'], vals: [1, d], y: r() < 1 / (1 + Math.exp(8 * (d - 0.5))) ? 1 : 0 }); }
  const m = new SparseBayesLogReg({ prior: { default: { prec: 0.1, mean: 0 }, rules: [] } }).fit(ex);
  assert.ok(m.predict(['b', 'n:d1'], [1, 0.25]).p > m.predict(['b', 'n:d1'], [1, 0.75]).p + 0.3);
});

test('auc sanity', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
});

const CFG = { epsilon: 0.25, halfLifeDays: 7, dedupe: { hardWindowDays: 2, t0: 7, scale: 2 }, explore: { gamma: 0.5, floor: 0.01 },
  slots: { primary: 5, science: 5, reserve: 2 }, desks: { core: 'primary', side: 'science' } };
const mk = (n, core, base) => Array.from({ length: n }, (_, i) => ({ id: `${core ? 'c' : 's'}${i}`, p: 0.2 + 0.05 * (i % 8), age_days: i, days_since_shown: null, cluster: base + (i % 3), core }));

test('selectBrief: slots, no dupes, core only in primary, round-robin spreads clusters', () => {
  const cands = [...mk(30, true, 0), ...mk(30, false, 10)];
  const before = JSON.stringify(cands);
  const out = selectBrief(cands, { ...CFG, epsilon: 0 }, mulberry32(1));
  assert.equal(JSON.stringify(cands), before);                       // input untouched
  const pri = out.primary.filter((c) => c.mode !== 'reserve');
  assert.equal(pri.length, 5);
  assert.ok(pri.every((c) => c.core));
  assert.equal(new Set(pri.map((c) => c.cluster)).size, 3);          // 3 core clusters all represented
  const ids = Object.values(out).flat().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(out.science.filter((c) => c.mode === 'reserve').length, 2);
});

test('selectBrief: hard dedupe window and backfill when a desk is short', () => {
  const cands = [...mk(2, true, 0), ...mk(20, false, 10)];
  cands[0].days_since_shown = 0.5;                                    // inside hard window -> removed
  const out = selectBrief(cands, { ...CFG, epsilon: 0 }, mulberry32(1));
  assert.ok(!Object.values(out).flat().some((c) => c.id === cands[0].id));
  assert.equal(out.primary.filter((c) => c.mode !== 'reserve').length, 5);   // backfilled from side items
});

test('epsilon=1 explores and still returns a valid brief', () => {
  const out = selectBrief([...mk(30, true, 0), ...mk(30, false, 10)], { ...CFG, epsilon: 1 }, mulberry32(2));
  assert.ok(out.primary.filter((c) => c.mode === 'explore').length >= 1);
});
