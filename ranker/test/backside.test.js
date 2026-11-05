// Run: node --test ranker/test/backside.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackside, poolCountsByCluster } from '../backside.js';

const unit = (...a) => { const n = Math.hypot(...a); return Float32Array.from(a.map((x) => x / n)); };
const interests = {
  clusters: [
    { id: 0, medoid: 'm0', size: 5, vec: unit(1, 0, 0) },
    { id: 1, medoid: 'ps:7', size: 2, vec: unit(0, 1, 0) },
  ],
};
const vecs = { a: unit(1, 0, 0), b: unit(1, 1, 0), c: unit(0, 0, 1), bad: Float32Array.of(1, 0) };
const cands = [
  { id: 'a', cluster: 0 }, { id: 'b', cluster: 0 }, { id: 'c', cluster: 1 }, { id: 'x', cluster: null },
];

test('pool counts ignore unclustered candidates', () => {
  assert.deepEqual([...poolCountsByCluster(cands)], [[0, 2], [1, 1]]);
});
test('cos_dist = 1 - cosine to the ASSIGNED medoid, rounded to 4dp', () => {
  const f = makeBackside(interests, (id) => vecs[id], poolCountsByCluster(cands));
  assert.deepEqual(f(cands[0]), { cos_dist: 0, cluster_size: 5, cluster_pool: 2, medoid_id: 'm0' });
  assert.equal(f(cands[1]).cos_dist, 0.2929);            // 1 - 1/sqrt(2)
  assert.equal(f(cands[2]).cos_dist, 1);                 // orthogonal to medoid 1
  assert.equal(f(cands[2]).medoid_id, 'ps:7');
});
test('cluster id may arrive as a string (DB stores TEXT)', () => {
  const f = makeBackside(interests, (id) => vecs[id], poolCountsByCluster(cands));
  assert.equal(f({ id: 'a', cluster: '1' }).medoid_id, 'ps:7');
});
test('missing / wrong-length vector -> cos_dist null but cluster facts kept', () => {
  const f = makeBackside(interests, (id) => vecs[id], poolCountsByCluster(cands));
  assert.equal(f({ id: 'nope', cluster: 0 }).cos_dist, null);
  assert.equal(f({ id: 'bad', cluster: 0 }).cos_dist, null);
  assert.equal(f({ id: 'nope', cluster: 0 }).cluster_size, 5);
});
test('no / unknown cluster -> all null', () => {
  const f = makeBackside(interests, (id) => vecs[id], poolCountsByCluster(cands));
  const none = { cos_dist: null, cluster_size: null, cluster_pool: null, medoid_id: null };
  assert.deepEqual(f({ id: 'a', cluster: null }), none);
  assert.deepEqual(f({ id: 'a', cluster: 99 }), none);
});
test('never negative from float error', () => {
  const v = unit(1, 2, 3);
  const f = makeBackside({ clusters: [{ id: 0, medoid: 'm', size: 1, vec: v }] }, () => v, new Map());
  assert.ok(f({ id: 'q', cluster: 0 }).cos_dist >= 0);
});
