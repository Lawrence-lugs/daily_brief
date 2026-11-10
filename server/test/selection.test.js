import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, freshness, greedyScore, exploreWeight, pickDesk, pickReserves, kindOf,
} from '../lib/selection.js';

function item(overrides = {}) {
  return {
    id: overrides.id ?? 'x',
    rel: overrides.rel ?? 0.5,
    age_days: overrides.age_days ?? 1,
    subtopic: overrides.subtopic ?? 'dse',
    times_shown: overrides.times_shown ?? 0,
    rejected: overrides.rejected ?? 0,
    source_type: overrides.source_type ?? 'newslike',
    ...overrides,
  };
}

const rng = () => 0.5; // deterministic: never epsilon-explore (0.5 > epsilon)

test('freshness: age 0 -> ~1, older -> lower, floor applied', () => {
  const cfg = { ...DEFAULTS };
  assert.ok(freshness(0, cfg) > 0.9);
  assert.ok(freshness(7, cfg) < freshness(0, cfg));
  assert.ok(freshness(30, cfg) < freshness(7, cfg));
  assert.equal(freshness(0.1, cfg), freshness(0.25, cfg)); // age_floor_days clamps
});

test('greedyScore: monotonic in rel, penalized by age/shown/rejected', () => {
  const cfg = { ...DEFAULTS };
  const base = item({ rel: 0.5, age_days: 1 });
  assert.ok(greedyScore(item({ rel: 0.8 }), cfg) > greedyScore(base, cfg));
  assert.ok(greedyScore(item({ age_days: 30 }), cfg) < greedyScore(base, cfg));
  assert.ok(greedyScore(item({ times_shown: 5 }), cfg) < greedyScore(base, cfg));
  assert.ok(greedyScore(item({ rejected: 3 }), cfg) < greedyScore(base, cfg));
});

test('exploreWeight: penalizes age less aggressively than greedy', () => {
  const cfg = { ...DEFAULTS };
  const young = item({ age_days: 1 });
  const old = item({ age_days: 30 });
  const greedyRatio = greedyScore(old, cfg) / greedyScore(young, cfg);
  const exploreRatio = exploreWeight(old, cfg) / exploreWeight(young, cfg);
  assert.ok(exploreRatio > greedyRatio);
});

test('pickDesk: returns n picks, respects subtopics', () => {
  const cfg = { ...DEFAULTS, epsilon: 0 };
  const cands = [
    item({ id: 'a', subtopic: 'dse', source_type: 'newslike', rel: 0.9 }),
    item({ id: 'b', subtopic: 'dse', source_type: 'newslike', rel: 0.8 }),
    item({ id: 'c', subtopic: 'fab', source_type: 'paperlike', rel: 0.9 }),
  ];
  const picks = pickDesk(cands, ['dse', 'fab'], 2, cfg, rng);
  assert.equal(picks.length, 2);
  const pickedIds = picks.map(([i]) => i.id);
  assert.ok(pickedIds.includes('a')); // highest rel greedy pick
});

test('pickDesk: skip_exhausted prefers never-shown subtopics first', () => {
  const cfg = { ...DEFAULTS, epsilon: 0, skip_exhausted_subtopics: true };
  const cands = [
    item({ id: 'a', subtopic: 'dse', source_type: 'newslike', rel: 0.9, times_shown: 0 }),
    item({ id: 'b', subtopic: 'dse', source_type: 'newslike', rel: 0.8, times_shown: 5 }),
    item({ id: 'c', subtopic: 'fab', source_type: 'paperlike', rel: 0.1, times_shown: 0 }),
  ];
  const picks = pickDesk(cands, ['dse', 'fab'], 2, cfg, rng);
  assert.ok(picks.length >= 1);
  const pickedIds = new Set(picks.map(([i]) => i.id));
  assert.ok(pickedIds.has('a')); // fresh dse picked before stale dse
});

test('pickReserves: top-k by greedy score, respects takenIds', () => {
  const cfg = { ...DEFAULTS, epsilon: 0 };
  const cands = [
    item({ id: 'a', source_type: 'newslike', rel: 0.9 }),
    item({ id: 'b', source_type: 'newslike', rel: 0.8 }),
    item({ id: 'c', source_type: 'paperlike', rel: 0.95 }),
  ];
  const taken = new Set(['b']);
  const reserves = pickReserves(cands, taken, 2, cfg);
  assert.ok(reserves.length <= 2);
  assert.ok(!reserves.some(r => r.id === 'b'));
  assert.ok(reserves.some(r => r.id === 'a') || reserves.some(r => r.id === 'c'));
});

test('kindOf: archive after archive_after_days, fresh otherwise', () => {
  const cfg = { ...DEFAULTS, archive_after_days: 7 };
  assert.equal(kindOf(item({ age_days: 1 }), cfg), 'fresh');
  assert.equal(kindOf(item({ age_days: 7 }), cfg), 'fresh');
  assert.equal(kindOf(item({ age_days: 7.01 }), cfg), 'archive');
  assert.equal(kindOf(item({ age_days: 30 }), cfg), 'archive');
});
