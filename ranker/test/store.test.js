// Tests for ranker/store.js using in-memory database
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, SQL } from '../store.js';
import { normalize } from '../vec.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCHEMA_FILE = resolve(__dirname, '..', '..', 'schema.sql');

function createTestStore() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  db.exec(readFileSync(SCHEMA_FILE, 'utf8'));
  const store = new Store(':memory:');
  // Override the store's db connection to use the test db
  store.db = db;
  // Re-prepare statements on the test db
  store.stmts = {
    missingEmbeddings: db.prepare(SQL.missingEmbeddings),
    likedIds: db.prepare(SQL.likedIds),
    lastShown: db.prepare(SQL.lastShown),
    trainingRows: db.prepare(SQL.trainingRows),
    pool: db.prepare(SQL.pool),
    prune: db.prepare(SQL.prune),
    embeddingById: db.prepare(SQL.embeddingById),
    embeddingAll: db.prepare(SQL.embeddingAll),
    upsertEmbedding: db.prepare(SQL.upsertEmbedding),
    getState: db.prepare(SQL.getState),
    setState: db.prepare(SQL.setState),
  };
  return store;
}

function seedTestData(store) {
  const now = '2026-10-29T12:00:00.000Z';
  // Insert some pool items
  for (const id of ['a', 'b', 'c']) {
    store.db.prepare(`INSERT INTO candidate_pool (item_id, url, title, snippet, published, source, source_type, subtopic, desk, rel, first_seen)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `https://x/${id}`, `Title ${id}`, `Snippet ${id}`, now, 'Test', 'newslike', 'sub', 'primary', 0.5, now);
  }
  // Insert item_meta
  store.db.prepare(`INSERT INTO item_meta (item_id, authors) VALUES (?, ?)`)
    .run('a', JSON.stringify(['Alice Smith']));
  store.db.prepare(`INSERT INTO item_meta (item_id, authors) VALUES (?, ?)`)
    .run('b', JSON.stringify(['Bob Jones', 'Carol White']));
  // Insert embeddings for a, b
  const vecA = normalize(Float32Array.from([1, 0, 0]));
  const vecB = normalize(Float32Array.from([0, 1, 0]));
  store.upsertEmbedding('a', 'test-model', 'hash1', 3, vecA);
  store.upsertEmbedding('b', 'test-model', 'hash2', 3, vecB);
  // Insert a brief with stories for likedIds/lastShown
  store.db.prepare(`INSERT INTO briefs (date, edition, generated_at, model, desks, meta) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('2026-10-28', 1, '2026-10-28T10:00:00.000Z', 'm', '{}', '{}');
  // One story per item (training_examples view picks MAX story_id per date,item_id)
  store.db.prepare(`INSERT INTO stories (brief_id, item_id, desk, position, headline, blurb, url, source, subtopic, source_type, age_days, tags, kind, liked, saved, liked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(1, 'a', 'primary', 0, 'Headline A', 'Blurb A', 'https://x/a', 'Test', 'sub', 'newslike', 1, '[]', 'fresh', 1, 0, '2026-10-28T10:00:00.000Z');
  store.db.prepare(`INSERT INTO stories (brief_id, item_id, desk, position, headline, blurb, url, source, subtopic, source_type, age_days, tags, kind, liked, saved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(1, 'b', 'primary', 1, 'Headline B', 'Blurb B', 'https://x/b', 'Test', 'sub', 'newslike', 2, '[]', 'fresh', 0, 0);
  store.db.prepare(`INSERT INTO stories (brief_id, item_id, desk, position, headline, blurb, url, source, subtopic, source_type, age_days, tags, kind, liked, saved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(1, 'c', 'primary', 2, 'Headline C', 'Blurb C', 'https://x/c', 'Test', 'sub', 'paperlike', 3, '[]', 'fresh', 0, 1);
}

test('store: getMissingEmbeddings returns pool items without embeddings', () => {
  const store = createTestStore();
  seedTestData(store);
  const missing = store.getMissingEmbeddings();
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'c');
  store.close();
});

test('store: getLikedIds returns liked OR saved items within cutoff', () => {
  const store = createTestStore();
  seedTestData(store);
  const liked = store.getLikedIds('2026-10-01'); // cutoff before 2026-10-28
  assert.deepEqual(liked.sort(), ['a', 'c']); // a is liked, c is saved
  store.close();
});

test('store: getLastShown returns last shown date per item', () => {
  const store = createTestStore();
  seedTestData(store);
  const last = store.getLastShown('2026-10-29');
  assert.equal(last.length, 3); // a, b, c all shown
  const byId = Object.fromEntries(last.map((r) => [r.item_id, r.last]));
  assert.ok(byId.a);
  assert.ok(byId.b);
  assert.ok(byId.c);
  store.close();
});

test('store: getTrainingRows returns one row per item with label', () => {
  const store = createTestStore();
  seedTestData(store);
  const rows = store.getTrainingRows();
  assert.equal(rows.length, 3); // a, b, c all have stories
  const byId = Object.fromEntries(rows.map((r) => [r.item_id, r]));
  assert.equal(byId.a.y, 1); // liked
  assert.equal(byId.a.authors.length, 1);
  assert.equal(byId.b.y, 0); // not liked/saved
  assert.equal(byId.c.y, 1); // saved
  assert.equal(byId.c.source_type, 'paperlike');
  store.close();
});

test('store: getPool returns pool items with parsed authors', () => {
  const store = createTestStore();
  seedTestData(store);
  const pool = store.getPool();
  assert.equal(pool.length, 3);
  const byId = Object.fromEntries(pool.map((r) => [r.item_id, r]));
  assert.deepEqual(byId.a.authors, ['Alice Smith']);
  assert.deepEqual(byId.b.authors, ['Bob Jones', 'Carol White']);
  assert.deepEqual(byId.c.authors, []);
  store.close();
});

test('store: embedding round-trip preserves vectors', () => {
  const store = createTestStore();
  const vec = normalize(Float32Array.from([0.6, 0.8, 0]));
  store.upsertEmbedding('test1', 'model', 'hash', 3, vec);
  const got = store.getEmbedding('test1');
  assert.ok(got);
  assert.equal(got.dim, 3);
  assert.equal(got.text_hash, 'hash');
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(got.vec[i] - vec[i]) < 1e-6);
  }
  store.close();
});

test('store: getAllEmbeddings returns all', () => {
  const store = createTestStore();
  seedTestData(store);
  const all = store.getAllEmbeddings();
  assert.equal(all.length, 2);
  const ids = all.map((e) => e.item_id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  store.close();
});

test('store: pruneEmbeddings removes non-pool non-story items', () => {
  const store = createTestStore();
  seedTestData(store);
  // Add an embedding for a non-existent item
  store.upsertEmbedding('z', 'model', 'hash', 3, normalize(Float32Array.from([0, 0, 1])));
  assert.equal(store.getAllEmbeddings().length, 3);
  store.pruneEmbeddings();
  const after = store.getAllEmbeddings();
  assert.equal(after.length, 2);
  const ids = after.map((e) => e.item_id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  store.close();
});

test('store: state get/set', () => {
  const store = createTestStore();
  assert.equal(store.getState('test_key'), null);
  store.setState('test_key', 'test_value');
  assert.equal(store.getState('test_key'), 'test_value');
  store.setState('test_key', 'updated');
  assert.equal(store.getState('test_key'), 'updated');
  store.close();
});