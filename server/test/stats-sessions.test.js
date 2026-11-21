// Unit test for the unique-sessions card: joins likes and saves per session,
// returns the five most active sessions and the like/save distributions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../ranker/store.js';
import { generate, sourceHash } from '../stats/cards/sessions.js';

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'db-stats-sessions-'));
}

function seed(dataDir, likes, saves) {
  const store = new Store(join(dataDir, 'daily_brief.db'));
  try {
    const likeStmt = store.db.prepare(
      'INSERT INTO likes(session_id, item_id, liked_at) VALUES(?,?,?)',
    );
    const saveStmt = store.db.prepare(
      'INSERT INTO saves(session_id, item_id, saved_at) VALUES(?,?,?)',
    );
    const now = new Date().toISOString();
    for (const [session, itemIds] of Object.entries(likes)) {
      for (const itemId of itemIds) likeStmt.run(session, itemId, now);
    }
    for (const [session, itemIds] of Object.entries(saves)) {
      for (const itemId of itemIds) saveStmt.run(session, itemId, now);
    }
  } finally {
    store.close();
  }
}

test('sessions: aggregates likes and saves, caps the table at 5, builds distributions', async () => {
  const dataDir = tempDataDir();
  try {
    seed(dataDir, {
      s1: ['a', 'b', 'c'],
      s2: ['a'],
      s4: ['a'],
      s5: ['a'],
      s6: ['a'],
      s7: ['a'],
    }, {
      s1: ['a'],
      s3: ['a', 'b'],
    });

    const payload = await generate(dataDir);

    assert.equal(payload.nSessions, 7, 'union of like-only, save-only and both sessions');
    assert.equal(payload.totalLikes, 8);
    assert.equal(payload.totalSaves, 3);

    assert.equal(payload.sessions.length, 5, 'table capped at 5 rows');
    assert.deepEqual(
      payload.sessions.map((s) => [s.sessionId, s.likes, s.saves, s.total]),
      [
        ['s1', 3, 1, 4],
        ['s3', 0, 2, 2],
        ['s2', 1, 0, 1],
        ['s4', 1, 0, 1],
        ['s5', 1, 0, 1],
      ],
    );

    // likes per session: s1=3, s2/s4/s5/s6/s7=1, s3=0 -> observed counts 0,1,3
    assert.deepEqual(payload.likeDist, { x: [0, 1, 3], y: [1, 5, 1] });
    // saves per session: s1=1, s3=2, everyone else 0 -> observed counts 0,1,2
    assert.deepEqual(payload.saveDist, { x: [0, 1, 2], y: [5, 1, 1] });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sessions: empty tables yield an empty payload', async () => {
  const dataDir = tempDataDir();
  try {
    seed(dataDir, {}, {});
    const payload = await generate(dataDir);
    assert.equal(payload.nSessions, 0);
    assert.deepEqual(payload.sessions, []);
    assert.deepEqual(payload.likeDist, { x: [], y: [] });
    assert.deepEqual(payload.saveDist, { x: [], y: [] });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sessions: sourceHash changes when a like is added', async () => {
  const dataDir = tempDataDir();
  try {
    seed(dataDir, { s1: ['a'] }, {});
    const before = await sourceHash(dataDir);
    seed(dataDir, { s1: ['b'] }, {});
    const after = await sourceHash(dataDir);
    assert.notEqual(before, after);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
