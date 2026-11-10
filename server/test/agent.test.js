import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson, applyEditor, applyEditorMulti, buildUserMessage, buildUserMessageMulti,
} from '../lib/agent.js';

const c = (id, overrides = {}) => ({
  id, title: `T ${id}`, snippet: `S ${id}`, subtopic: 'dse', source: 'arXiv',
  source_type: 'newslike', age_days: 1, desk: 'primary', ...overrides,
});

test('extractJson: plain JSON, fenced JSON, embedded braces', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a": 1} suffix'), { a: 1 });
  assert.throws(() => extractJson('not json at all'), /could not extract JSON/);
});

test('extractJson: salvage recovers multiple balanced objects from malformed text', () => {
  const text = 'blah {"id":"a","headline":"H","blurb":"B"} more {"id":"b","keep":false} end';
  const s = extractJson(text);
  assert.ok(s._salvaged);
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].id, 'a');
  assert.equal(s.items[1].keep, false);
  assert.throws(() => extractJson('no objects here'), /could not extract JSON/);
});

test('applyEditor: keeps kept items, drops keep:false, fills missing up to n', () => {
  const cands = [c('a'), c('b'), c('c')];
  const result = {
    deck: 'A deck',
    items: [
      { id: 'a', headline: 'Head A', blurb: 'Blurb A', keep: true },
      { id: 'b', headline: '', blurb: 'Blurb B', keep: false },
      { id: 'c', headline: 'Head C', blurb: 'Blurb C' },
      { id: 'z', headline: 'Head Z', blurb: 'Blurb Z' },
    ],
  };
  const [stories, rejected, deck] = applyEditor(cands, result, 2);
  assert.equal(deck, 'A deck');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0], 'b');
  assert.equal(stories.length, 2);
  assert.equal(stories[0].headline, 'Head A');
  assert.equal(stories[0].summarized, true);
  assert.ok(stories.some(s => s.id === 'c'));
});

test('applyEditor: lead_id sorts lead to front', () => {
  const cands = [c('a'), c('b')];
  const result = {
    items: [
      { id: 'b', headline: 'Head B', blurb: 'Blurb B' },
      { id: 'a', headline: 'Head A', blurb: 'Blurb A' },
    ],
    lead_id: 'b',
  };
  const [stories] = applyEditor(cands, result, 2);
  assert.equal(stories[0].id, 'b');
});

test('applyEditorMulti: per-desk split, fill-up from cands', () => {
  const selectedByDesk = {
    primary: [c('a', { desk: 'primary' }), c('b', { desk: 'primary' })],
    science: [c('c', { desk: 'science' })],
  };
  const result = {
    decks: { primary: { deck: 'P deck', lead_id: 'a' } },
    items: [
      { id: 'a', desk: 'primary', headline: 'Head A', blurb: 'Blurb A' },
      { id: 'c', desk: 'science', headline: 'Head C', blurb: 'Blurb C' },
    ],
  };
  const out = applyEditorMulti(selectedByDesk, result, 2);
  assert.ok('primary' in out && 'science' in out);
  assert.equal(out.primary[0][0].id, 'a');
  assert.equal(out.primary[2], 'P deck');
  assert.equal(out.science[0][0].id, 'c');
});

test('buildUserMessage: includes cap, today, candidates', () => {
  const msg = buildUserMessage('Primary Desk', 2, [c('a')], 'Tuesday, January 1, 2026');
  assert.ok(msg.includes('Primary Desk'));
  assert.ok(msg.includes('Keep at least 2'));
  assert.ok(msg.includes('T a'));
  assert.ok(msg.includes('S a'));
});

test('buildUserMessageMulti: multiple desks, per-desk cap, never change desk', () => {
  const desks = [{ key: 'primary', title: 'Primary' }, { key: 'science', title: 'Science' }];
  const candsByDesk = { primary: [c('a', { desk: 'primary' })], science: [c('c', { desk: 'science' })] };
  const msg = buildUserMessageMulti(desks, 2, candsByDesk, 'Today', 2);
  assert.ok(msg.includes('DESK: primary — Primary'));
  assert.ok(msg.includes('DESK: science — Science'));
  assert.ok(msg.includes("Never change an item's desk"));
});
