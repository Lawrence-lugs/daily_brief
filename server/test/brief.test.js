import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/brief.js';

// classify is pure keyword matching; importing brief.js pulls in ranker modules
// but they load cleanly without a DB, so no mocking is needed here.

test('classify: keyword matching, hint boost, rel calc, null when no match', async () => {
  const keywords = { dse: ['transformer', 'attention'], fab: ['lithography'] };
  const sub2Desk = { dse: 'primary', fab: 'science' };

  const a = classify({ title: 'Transformer networks', snippet: '', weight: 1.0 }, keywords, sub2Desk);
  assert.equal(a.subtopic, 'dse');
  assert.equal(a.desk, 'primary');
  assert.ok(a.rel > 0);

  const b = classify({ title: 'Hardware news', snippet: 'attention transformer', weight: 1.0 }, keywords, sub2Desk);
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
  const keywords = { dse: ['ai'] };
  const sub2Desk = { dse: 'primary' };

  assert.equal(classify({ title: 'aide', snippet: '', weight: 1.0 }, keywords, sub2Desk), null);
  assert.equal(classify({ title: 'raid', snippet: '', weight: 1.0 }, keywords, sub2Desk), null);
  assert.ok(classify({ title: 'ai', snippet: '', weight: 1.0 }, keywords, sub2Desk));
  assert.ok(classify({ title: 'AI breakthrough', snippet: '', weight: 1.0 }, keywords, sub2Desk));
});
