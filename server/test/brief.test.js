import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, UNPLACED_SUBTOPIC, UNPLACED_DESK } from '../lib/brief.js';

// classify is pure keyword matching; importing brief.js pulls in ranker modules
// but they load cleanly without a DB, so no mocking is needed here.

test('classify: keyword matching, hint boost, rel calc, never rejects', async () => {
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

  // No keyword signal is no longer a rejection: the item is admitted, labelled
  // unclassified/misc, and gets the minimum rel.
  const d = classify({ title: 'unrelated story', snippet: 'nothing here', weight: 1.0 }, keywords, sub2Desk);
  assert.equal(d.subtopic, UNPLACED_SUBTOPIC);
  assert.equal(d.desk, UNPLACED_DESK);
  assert.equal(d.rel, 0.3);

  const e = classify({ title: 'fab', snippet: '', weight: 1.0, hint: 'fab' }, keywords, sub2Desk);
  assert.equal(e.subtopic, 'fab');
  assert.ok(e.rel >= 0.05);
});

test('classify: a single stray term does not place an item', async () => {
  const keywords = { dse: ['transformer', 'attention'], fab: ['lithography'] };
  const sub2Desk = { dse: 'primary', fab: 'science' };

  // One body-only hit (< 2) and no hint: admitted, but not placed.
  const weak = classify({ title: 'unrelated', snippet: 'one transformer mention', weight: 1.0 }, keywords, sub2Desk);
  assert.equal(weak.subtopic, UNPLACED_SUBTOPIC);
  assert.equal(weak.desk, UNPLACED_DESK);
  assert.equal(weak.rel, 0.3);
});

test('classify: term regex boundaries, short terms get trailing boundary', async () => {
  const keywords = { dse: ['ai'] };
  const sub2Desk = { dse: 'primary' };

  // 'aide'/'raid' must not match 'ai'; they are admitted but unplaced.
  assert.equal(classify({ title: 'aide', snippet: '', weight: 1.0 }, keywords, sub2Desk).subtopic, UNPLACED_SUBTOPIC);
  assert.equal(classify({ title: 'raid', snippet: '', weight: 1.0 }, keywords, sub2Desk).subtopic, UNPLACED_SUBTOPIC);
  assert.equal(classify({ title: 'ai', snippet: '', weight: 1.0 }, keywords, sub2Desk).subtopic, 'dse');
  assert.equal(classify({ title: 'AI breakthrough', snippet: '', weight: 1.0 }, keywords, sub2Desk).subtopic, 'dse');
});
