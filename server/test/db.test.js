import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  tx, loadPool, loadLikedIds, upsertPool, deletePool, prunePool,
  sameDayCounts, insertBrief, appendBrief,
} from '../lib/db.js';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

// NOTE: db.connect() has a pre-existing bug (conn.exec with bound params), so we
// construct the in-memory DB directly via the schema, bypassing connect().
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  return db;
}

function addBriefRow(db, date, counted = 1) {
  const r = db.prepare(
    'INSERT INTO briefs(date, edition, generated_at, model, llm_requests, counted, rejected_ids, desks, meta) VALUES(?,1,?,?,0,?,\'[]\',\'{}\',\'{}\')',
  ).run(date, new Date(date + 'T12:00:00Z').toISOString(), 'm', counted);
  return Number(r.lastInsertRowid);
}

function addStoryRow(db, briefId, o = {}) {
  const id = o.item_id ?? 'item-' + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO stories(brief_id,item_id,desk,position,headline,blurb,why_care,tags,
    significance,summarized,url,source,source_type,subtopic,kind,mode,age_days,rel,
    times_shown_before,cluster,core,score_p,score_v,cos_dist,cluster_size,cluster_pool,medoid_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(briefId, id, o.desk ?? 'primary', o.position ?? 0, o.headline ?? 'Headline', o.blurb ?? '', '',
      '[]', o.significance ?? 3, o.summarized ?? 1, o.url ?? 'http://x/' + id, o.source ?? 'arXiv',
      o.source_type ?? 'commentary', o.subtopic ?? 'dse', o.kind ?? 'fresh', o.mode ?? 'greedy',
      o.age_days ?? 0, o.rel ?? 0.5, o.times_shown ?? 0, o.cluster ?? null, o.core ?? 0,
      null, null, null, null, null, null);
  if (o.liked) db.prepare(`INSERT INTO likes (session_id, item_id, liked_at) VALUES ('s1', ?, ?)`).run(id, new Date().toISOString());
  if (o.saved) db.prepare(`INSERT INTO saves (session_id, item_id, saved_at) VALUES ('s1', ?, ?)`).run(id, new Date().toISOString());
  return id;
}

function addPoolRow(db, o = {}) {
  const id = o.id ?? 'pool-' + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO candidate_pool
    (item_id, url, title, snippet, published, source, source_type, subtopic, desk, rel, first_seen, last_shown, times_shown, rejected)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, o.url ?? 'http://x/' + id, o.title ?? 'T', o.snippet ?? '',
      o.published ?? new Date('2026-01-01').toISOString(), o.source ?? 'arXiv',
      o.source_type ?? 'newslike', o.subtopic ?? 'dse', o.desk ?? 'primary',
      o.rel ?? 0.5, new Date('2026-01-01').toISOString(), null, 0, 0);
  return id;
}

test('tx: commits on success, rolls back on error', () => {
  const db = freshDb();
  addBriefRow(db, '2026-01-01');
  assert.throws(() => tx(db, () => {
    db.prepare('INSERT INTO stories(brief_id,item_id,desk,position,headline,blurb,url,source,subtopic,kind,mode,age_days,rel,times_shown_before,cluster,core) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(99999, 'x', 'primary', 0, 'h', 'b', 'http://x', 's', 'dse', 'fresh', 'greedy', 0, 0.5, 0, null, 0, 0);
  }));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM stories').get().c, 0);
});

test('upsertPool / loadPool: inserts new, updates rel on conflict, sets id field', () => {
  const db = freshDb();
  const added = upsertPool(db, [{
    id: 'p1', url: 'http://x/p1', title: 'T1', snippet: 'S', published: null,
    source: 'arXiv', subtopic: 'dse', desk: 'primary', rel: 0.5,
  }], new Date('2026-01-01T12:00:00Z'));
  assert.equal(added, 1);
  const pool = loadPool(db);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].id, 'p1');
  assert.equal(pool[0].title, 'T1');
  const added2 = upsertPool(db, [{
    id: 'p1', url: 'http://x/p1', title: 'T1', snippet: 'S2', published: null,
    source: 'arXiv', subtopic: 'dse', desk: 'primary', rel: 0.9,
  }], new Date('2026-01-02T12:00:00Z'));
  assert.equal(added2, 0);
  assert.equal(loadPool(db)[0].rel, 0.9);
});

test('loadLikedIds: returns liked/saved item ids', () => {
  const db = freshDb();
  const bid = addBriefRow(db, '2026-01-01');
  addStoryRow(db, bid, { item_id: 'liked1', liked: 1 });
  addStoryRow(db, bid, { item_id: 'saved1', saved: 1 });
  addStoryRow(db, bid, { item_id: 'plain1' });
  const all = loadLikedIds(db);
  assert.ok(all.has('liked1'));
  assert.ok(all.has('saved1'));
  assert.ok(!all.has('plain1'));
});

test('deletePool: removes listed ids', () => {
  const db = freshDb();
  addPoolRow(db, { id: 'd1' });
  addPoolRow(db, { id: 'd2' });
  assert.equal(loadPool(db).length, 2);
  deletePool(db, ['d1']);
  assert.equal(loadPool(db).length, 1);
  assert.equal(loadPool(db)[0].id, 'd2');
});

test('prunePool: removes items older than maxAgeDays', () => {
  const db = freshDb();
  addPoolRow(db, { id: 'fresh', published: new Date('2026-01-10').toISOString() });
  addPoolRow(db, { id: 'stale', published: new Date('2026-01-01').toISOString() });
  const now = new Date('2026-01-15T12:00:00Z');
  assert.equal(prunePool(db, now, 7), 1);
  assert.equal(loadPool(db).length, 1);
  assert.equal(loadPool(db)[0].id, 'fresh');
});

test('sameDayCounts: counts shown and rejected per item for a date', () => {
  const db = freshDb();
  const bid1 = addBriefRow(db, '2026-01-01');
  addStoryRow(db, bid1, { item_id: 'a' });
  addStoryRow(db, bid1, { item_id: 'b' });
  const bid2 = addBriefRow(db, '2026-01-01');
  addStoryRow(db, bid2, { item_id: 'a' });
  const [shown, rejected] = sameDayCounts(db, '2026-01-01');
  assert.equal(shown['a'], 2);
  assert.equal(shown['b'], 1);
  assert.equal(rejected['a'], undefined);
});

test('appendBrief: creates brief + stories, increments times_shown, rejects', () => {
  const db = freshDb();
  addPoolRow(db, { id: 's1' });
  const bid = appendBrief(db, {
    dateKey: '2026-01-01', now: new Date('2026-01-01T12:00:00Z'), model: 'm',
    llmRequests: 0, rejectedIds: ['x1'], desksOut: {
      primary: { title: 'Primary', deck: 'D', stories: [
        { id: 's1', headline: 'H1', blurb: 'B1', tags: [], significance: 3, summarized: 1,
          url: 'http://x/s1', source: 'arXiv', source_type: 'newslike', subtopic: 'dse',
          kind: 'fresh', mode: 'greedy', age_days: 0, rel: 0.5 },
      ] },
    }, meta: { n_fresh: 1 },
  });
  assert.ok(bid);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM stories WHERE brief_id = ?').get(bid).c, 1);
  // times_shown incremented for s1
  const pool = loadPool(db);
  const s1 = pool.find(p => p.id === 's1');
  assert.equal(s1.times_shown, 1);
  // rejected incremented for x1 (if it exists in pool)
  addPoolRow(db, { id: 'x1' });
  appendBrief(db, {
    dateKey: '2026-01-02', now: new Date('2026-01-02T12:00:00Z'), model: 'm',
    llmRequests: 0, rejectedIds: ['x1'], desksOut: {
      primary: { title: 'Primary', deck: 'D', stories: [] },
    }, meta: { n_fresh: 0 },
  });
  const x1 = loadPool(db).find(p => p.id === 'x1');
  assert.equal(x1.rejected, 1);
});
