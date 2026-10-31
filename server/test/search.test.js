// Run: node --test server/test/search.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildMatch, ensureFtsBuilt, makeSearch } from '../lib/search.js';

const SCHEMA = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  db.exec(SCHEMA); // idempotent: second run must not throw
  return db;
}
// NOTE: the rank=1 form is the only one that compares the index against the content table;
// SELECT count(*) FROM stories_fts always looks healthy because it counts the content table.
const INTEGRITY = "INSERT INTO stories_fts(stories_fts, rank) VALUES('integrity-check', 1)";
let n = 0;
function addBrief(db, date) {
  const r = db.prepare("INSERT INTO briefs(date,edition,generated_at,model,desks,meta) VALUES(?,1,?,'m','{}','{}')")
    .run(date, new Date(Date.now() + n++).toISOString());
  return Number(r.lastInsertRowid);
}
function addStory(db, brief, o) {
  const s = { desk: 'primary', subtopic: 'dse', source: 'arXiv', blurb: '', why_care: '', tags: [], url: 'http://x/' + o.item_id, ...o };
  db.prepare(`INSERT INTO stories(brief_id,item_id,desk,position,headline,blurb,why_care,tags,url,source,subtopic,liked,saved)
              VALUES(?,?,?,0,?,?,?,?,?,?,?,?,?)`)
    .run(brief, s.item_id, s.desk, s.headline, s.blurb, s.why_care, JSON.stringify(s.tags), s.url, s.source, s.subtopic, s.liked ?? 0, s.saved ?? 0);
}
const sp = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) [].concat(v).forEach((x) => u.append(k, x)); return u; };

test('buildMatch', () => {
  const cases = [
    ['', null], ['   ', null], ['***', null], ['( ) : *', null],
    ['transformer', '"transformer"*'],
    ['transformer ', '"transformer"'],
    ['sparse transf', '"sparse" "transf"*'],
    ['"design space" dse', '"design space" "dse"*'],
    ['title:foo', 'headline : "foo"*'],
    ['blob:"kv cache"', 'blurb : "kv cache"'],
    ['AND OR NOT', '"AND" "OR" "NOT"*'],
    ['foo"bar', '"foo""bar"*'],
    ['a', '"a"'], // 1-char last token: no prefix
  ];
  for (const [input, want] of cases) assert.equal(buildMatch(input), want, JSON.stringify(input));
  assert.ok(buildMatch('https://x.org/a'));
});

test('hostile input never throws', () => {
  const db = freshDb();
  addStory(db, addBrief(db, '2026-10-01'), { item_id: 'a', headline: 'Sparse attention' });
  const { listStories } = makeSearch(db);
  for (const q of ['AND', 'NOT x', '(', ')', '"', '""', 'a:b:c', '*', 'x OR', 'NEAR(a b)', "it's", 'col:', '-foo', '\\', '😀']) {
    assert.doesNotThrow(() => listStories(sp({ q })), JSON.stringify(q));
  }
});

test('search, ranking, highlight, column filter, stemming', () => {
  const db = freshDb();
  const b = addBrief(db, '2026-10-01');
  addStory(db, b, { item_id: 'a', headline: 'Sparse attention accelerators', blurb: 'Hardware for sparsity', tags: ['accel'] });
  addStory(db, b, { item_id: 'b', headline: 'Foundry news', blurb: 'A sparse roadmap of transformers', tags: ['fab'], source: 'SemiWiki', subtopic: 'fab' });
  const { listStories } = makeSearch(db);
  let r = listStories(sp({ q: 'sparse' }));
  assert.equal(r.total, 2);
  assert.equal(r.rows[0].item_id ?? r.rows[0].headline, 'Sparse attention accelerators'); // headline weighs more than blurb
  assert.match(r.rows[0].h_headline, /\x01Sparse\x02/);
  assert.equal(listStories(sp({ q: 'blob:roadmap' })).total, 1);         // column filter: only story b's blurb
  assert.equal(listStories(sp({ q: 'blob:foundry' })).total, 0);          // 'foundry' appears only in a headline
  assert.equal(listStories(sp({ q: 'blob:sparse' })).total, 2);           // porter: sparse ~ sparsity (both blurbs)
  assert.equal(listStories(sp({ q: 'title:foundry' })).total, 1);
  assert.equal(listStories(sp({ q: 'transformer ' })).total, 1);          // porter: transformer ~ transformers
  assert.equal(listStories(sp({ q: 'sparse transf' })).total, 1);         // prefix on last word
  assert.equal(listStories(sp({ q: 'source:semiwiki' })).total, 1);
  assert.equal(listStories(sp({ q: 'nonexistentword' })).total, 0);
});

test('filters: mark, tag, desk, dates, empty query ordering, paging', () => {
  const db = freshDb();
  const b1 = addBrief(db, '2026-10-01'); const b2 = addBrief(db, '2026-10-02');
  addStory(db, b1, { item_id: 'a', headline: 'A', liked: 1, tags: ['dse', 'accel'] });
  addStory(db, b1, { item_id: 'b', headline: 'B', saved: 1, desk: 'science', tags: ['gr'] });
  addStory(db, b2, { item_id: 'c', headline: 'C', tags: ['dse'] });
  const { listStories } = makeSearch(db);
  assert.deepEqual(listStories(sp({})).rows.map((x) => x.headline), ['C', 'B', 'A']);        // newest first
  assert.equal(listStories(sp({ mark: 'liked' })).total, 1);
  assert.equal(listStories(sp({ mark: 'saved' })).total, 1);
  assert.equal(listStories(sp({ mark: 'any' })).total, 2);
  assert.equal(listStories(sp({ tag: 'dse' })).total, 2);
  assert.equal(listStories(sp({ tag: ['dse', 'accel'] })).total, 1);                           // tags AND together
  assert.equal(listStories(sp({ desk: 'science' })).total, 1);
  assert.equal(listStories(sp({ from: '2026-10-02' })).total, 1);
  assert.equal(listStories(sp({ to: '2026-10-01' })).total, 2);
  assert.equal(listStories(sp({ from: 'garbage' })).total, 3);                                 // bad date ignored
  const p = listStories(sp({ limit: 2, offset: 2 }));
  assert.equal(p.total, 3); assert.equal(p.rows.length, 1);
  assert.equal(listStories(sp({ sort: 'rank' })).total, 3);                                    // rank w/o query falls back
});

test('dedupe: regenerated same-day brief and carried feedback count once', () => {
  const db = freshDb();
  const b1 = addBrief(db, '2026-10-01'); const b2 = addBrief(db, '2026-10-01'); const b3 = addBrief(db, '2026-10-02');
  addStory(db, b1, { item_id: 'a', headline: 'Same story v1' });
  addStory(db, b2, { item_id: 'a', headline: 'Same story v2', liked: 1 });    // regeneration, feedback carried
  addStory(db, b3, { item_id: 'a', headline: 'Same story v2 again' });         // different day: separate entry
  const { listStories } = makeSearch(db);
  assert.equal(listStories(sp({})).total, 2);
  assert.equal(listStories(sp({ q: 'story' })).total, 2);
  assert.equal(listStories(sp({ q: 'v1' })).total, 0);                          // superseded row is not searchable
  assert.equal(listStories(sp({ mark: 'liked' })).total, 1);
});

test('index stays in sync: update text, delete; like toggles do not disturb it', () => {
  const db = freshDb();
  const b = addBrief(db, '2026-10-01');
  addStory(db, b, { item_id: 'a', headline: 'Alpha story' });
  const { listStories } = makeSearch(db);
  assert.equal(listStories(sp({ q: 'alpha' })).total, 1);
  db.exec("UPDATE stories SET liked = 1, liked_at = 'x' WHERE item_id = 'a'");
  assert.equal(listStories(sp({ q: 'alpha', mark: 'liked' })).total, 1);
  db.exec("UPDATE stories SET headline = 'Beta story' WHERE item_id = 'a'");
  assert.equal(listStories(sp({ q: 'alpha' })).total, 0);
  assert.equal(listStories(sp({ q: 'beta' })).total, 1);
  db.exec('DELETE FROM briefs');                                                // FK cascade -> stories -> trigger
  assert.equal(listStories(sp({ q: 'beta' })).total, 0);
  assert.doesNotThrow(() => db.exec(INTEGRITY));
});

test('ensureFtsBuilt backfills rows that predate the index, once', () => {
  const db = freshDb();
  const b = addBrief(db, '2026-10-01');
  db.exec('DROP TRIGGER stories_fts_ai');                                       // simulate pre-FTS rows
  addStory(db, b, { item_id: 'old', headline: 'Legacy compute-in-memory paper' });
  const { listStories } = makeSearch(db);
  assert.equal(listStories(sp({ q: 'legacy' })).total, 0);
  assert.throws(() => db.exec(INTEGRITY));                                      // index is out of sync with content
  assert.equal(ensureFtsBuilt(db), true);
  assert.doesNotThrow(() => db.exec(INTEGRITY));
  assert.equal(listStories(sp({ q: 'legacy' })).total, 1);
  assert.equal(ensureFtsBuilt(db), false);                                      // second call is a no-op
});

test('facets', () => {
  const db = freshDb();
  const b = addBrief(db, '2026-10-01');
  addStory(db, b, { item_id: 'a', headline: 'A', tags: ['dse', 'accel'] });
  addStory(db, b, { item_id: 'b', headline: 'B', tags: ['dse'], desk: 'science' });
  const f = makeSearch(db).facets();
  assert.deepEqual(f.tag.map((t) => [t.value, t.n]), [['dse', 2], ['accel', 1]]);
  assert.equal(f.desk.length, 2);
  assert.ok(f.source.length && f.subtopic.length);
});