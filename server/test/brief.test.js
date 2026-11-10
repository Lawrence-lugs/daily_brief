import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// brief.js imports ranker modules at the top level; mock them before importing.
// Node >= 22.13 top-level mock() intercepts module resolution for subsequent imports.

async function mockRanker() {
  await mock('../../ranker/store.js', { Store: class { close() {} } });
  await mock('../../ranker/pipeline.js', {
    ensureEmbeddings: async () => {},
    ensureFitted: async () => ({ interests: { clusters: [] } }),
    prepareCandidates: () => [],
  });
  await mock('../../ranker/sampler.js', {
    mulberry32: () => () => 0.5,
    selectBrief: () => ({}),
  });
  await mock('../../ranker/backside.js', {
    makeBackside: () => () => ({}),
    poolCountsByCluster: () => ({}),
  });
  await mock('../../ranker/vec.js', { fromBlob: (b) => b });
}

test('classify: keyword matching, hint boost, rel calc, null when no match', async () => {
  await mockRanker();
  const { classify } = await import('../lib/brief.js');

  const keywords = { dse: ['transformer', 'attention'], fab: ['lithography'] };
  const sub2Desk = { dse: 'primary', fab: 'science' };

  const a = classify({ title: 'Transformer networks', snippet: '', weight: 1.0 }, keywords, sub2Desk);
  assert.equal(a.subtopic, 'dse');
  assert.equal(a.desk, 'primary');
  assert.ok(a.rel > 0);

  const b = classify({ title: 'Hardware news', snippet: 'attention mechanisms', weight: 1.0 }, keywords, sub2Desk);
  assert.equal(b.subtopic, 'dse');

  const c = classify({ title: 'X', snippet: 'y', weight: 1.0, hint: 'fab' }, keywords, sub2Desk);
  assert.equal(c.subtopic, 'fab');

  const d = classify({ title: 'unrelated story', snippet: 'nothing here', weight: 1.0 }, keywords, sub2Desk);
  assert.equal(d, null);

  const e = classify({ title: 'fab', snippet: '', weight: 1.0, hint: 'fab' }, keywords, sub2Desk);
  assert.equal(e.subtopic, 'fab');
  assert.ok(e.rel >= 0.05);
});

test('classify: term regex boundaries, short terms get trailing boundary', async () => {
  await mockRanker();
  const { classify } = await import('../lib/brief.js');

  const keywords = { dse: ['ai'] };
  const sub2Desk = { dse: 'primary' };

  assert.equal(classify({ title: 'aide', snippet: '', weight: 1.0 }, keywords, sub2Desk), null);
  assert.equal(classify({ title: 'raid', snippet: '', weight: 1.0 }, keywords, sub2Desk), null);
  assert.ok(classify({ title: 'ai', snippet: '', weight: 1.0 }, keywords, sub2Desk));
  assert.ok(classify({ title: 'AI breakthrough', snippet: '', weight: 1.0 }, keywords, sub2Desk));
});
