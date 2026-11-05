// Run: npm test   (picked up by node --test server/test/*.test.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fill } from '../lib/render.js';
import { formatBackside, fmtScore } from '../lib/backside.js';

const tplDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const tpl = (n) => readFileSync(path.join(tplDir, n), 'utf8');
const placeholders = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

test('fmtScore', () => {
  assert.equal(fmtScore(0.73123), '0.731');
  assert.equal(fmtScore(0), '0.000');
  assert.equal(fmtScore(0.0000123), '1.2e-5');
  assert.equal(fmtScore(null), '\u2014');
  assert.equal(fmtScore(NaN), '\u2014');
});
test('formatBackside: full snapshot', () => {
  const f = formatBackside({ score_p: 0.7, score_v: 0.25, cos_dist: 0.1234, cluster_size: 7, cluster_pool: 19,
    medoid_id: 'm0', medoid_title: 'Sparse attention kernels' });
  assert.deepEqual(f, { pool: '19 candidates \u00b7 7 interest points', p: '0.700', v: '0.250',
    medoid: 'Sparse attention kernels', dist: '0.123', note: '' });
});
test('formatBackside: keyword / legacy story shows dashes and a note, never live-lookup data', () => {
  const f = formatBackside({ score_p: null, clusterMedoidTitle: 'LIVE (maybe wrong cluster)' });
  assert.equal(f.pool, '\u2014'); assert.equal(f.medoid, '\u2014'); assert.equal(f.dist, '\u2014');
  assert.match(f.note, /No ranker data/);
});
test('formatBackside: medoid falls back to its id when the title cannot be resolved', () => {
  assert.equal(formatBackside({ medoid_id: 'ps:9' }).medoid, 'ps:9');
});
test('story-back.html placeholders == formatBackside keys (no orphan, no unused)', () => {
  const keys = Object.keys(formatBackside({})).sort();
  assert.deepEqual([...new Set(placeholders(tpl('story-back.html')))].sort(), keys);
});
test('back is HTML-escaped', () => {
  const html = fill(tpl('story-back.html'), formatBackside({ medoid_id: 'm', medoid_title: '<img src=x onerror=1>' }));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});
test('front templates carry the flip wiring', () => {
  for (const n of ['story.html', 'lead.html']) {
    const t = tpl(n);
    assert.ok(t.includes('{{back}}'), n);
    assert.ok(t.includes('data-flip'), n);
    assert.ok(t.includes('story-front'), n);
    assert.ok(/<article class="story-card /.test(t), n);
  }
  // back button must NOT use data-action (client.js would treat it as like/save)
  assert.ok(!tpl('story-back.html').includes('data-action'));
});
