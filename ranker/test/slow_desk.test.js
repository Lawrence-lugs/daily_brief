import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../features.js';
import { journalFrontMatter } from '../journal.js';
import { selectBrief, mulberry32 } from '../sampler.js';

const cfg = { epsilon: 0, halfLifeDays: 30, freshness: { model: 'exponential' }, shown_decay: .05,
  dedupe: { hardWindowDays: 2, t0: 7, scale: 2 }, explore: { gamma: .5, floor: .01 },
  stories_per_desk: 3, reserve_per_desk: 2,
  slowDesks: { rf: { rollover: true, repeatWeight: .8, minValue: .12, titleTerms: ['receiver'] } } };
const item = (id, p, extra = {}) => ({ id, p, desk: 'rf', cluster: 1, title: 'Receiver design',
  age_days: 0, times_shown: 0, days_since_shown: null, ...extra });

test('rolling greedy picks admit qualified incumbents, rank new work first and retain prior order', () => {
  const previous = { previousDesk: 'rf', days_since_shown: 1, times_shown: 20 };
  const pool = [item('old1', .8, { ...previous, previousPosition: 1 }),
    item('old2', .9, { ...previous, previousPosition: 2 }), item('new', .3),
    item('mismatch', .99, { title: 'Graph partitioning' }), item('low', .08),
    item('recent-explore', .95, { days_since_shown: 1 }), item('qualified-reserve', .2)];
  const picks = selectBrief(pool, cfg, mulberry32(1)).rf;
  assert.deepEqual(picks.map(c => c.id), ['new','old1','old2','qualified-reserve']);
  assert.equal(picks.at(-1).mode, 'reserve');
  assert.equal(picks[1].V, .8 * .8);
});

test('epsilon can discover an off-topic candidate without promoting it into a greedy slot or reserve', () => {
  const c = item('novel', .3, { title: 'Novel result' });
  assert.deepEqual(selectBrief([c], cfg, mulberry32(1)).rf, []);
  assert.equal(selectBrief([c], { ...cfg, epsilon: 1 }, mulberry32(1)).rf[0].mode, 'explore');
});

test('RSS and API aliases share Bayesian features and journal notices are distinguishable from research', () => {
  const a = { source: 'IEEE Journal of Solid-State Circuits', title: 'Information for Authors' };
  const b = { feed: 'IEEE JSSC — Solid-State Circuits', title: 'A low-power receiver' };
  assert.deepEqual(encode(a, {}, ['journal']), encode(b, {}, ['journal']));
  assert.equal(journalFrontMatter(a), true);
  assert.equal(journalFrontMatter(b), false);
  assert.deepEqual(encode({ source: 'IEEE Spectrum' }, {}, ['journal']).keys, []);
});
