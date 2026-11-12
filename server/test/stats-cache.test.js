// Unit test for server/stats/cache.js: write→read round trip, atomic rename (tmp
// file gone), and isOutdated cases. Uses a temp data dir so it never touches the
// real per-user data directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCard, writeCard, isOutdated } from '../stats/cache.js';

test('writeCard then readCard round trip', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'db-stats-cache-'));
  try {
    const stored = writeCard('feeds', { sourceHash: 'abc123', payload: { rows: [] } }, dataDir);
    assert.equal(stored.cardId, 'feeds');
    assert.equal(stored.sourceHash, 'abc123');
    assert.deepEqual(stored.payload, { rows: [] });
    assert.ok(stored.generatedAt, 'generatedAt set');

    const back = readCard('feeds', dataDir);
    assert.deepEqual(back, stored);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('readCard returns null for missing card', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'db-stats-cache-'));
  try {
    assert.equal(readCard('pv_hist', dataDir), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('atomic rename leaves no .tmp file', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'db-stats-cache-'));
  try {
    writeCard('lr_metrics', { sourceHash: 'x', payload: {} }, dataDir);
    const entries = readdirSync(join(dataDir, 'stats'));
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), 'no tmp file left behind');
    assert.ok(entries.includes('lr_metrics.json'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('isOutdated: null stored', () => {
  assert.equal(isOutdated(null, 'anything'), true);
});

test('isOutdated: matching hash is not outdated', () => {
  assert.equal(isOutdated({ sourceHash: 'h1' }, 'h1'), false);
});

test('isOutdated: differing hash is outdated', () => {
  assert.equal(isOutdated({ sourceHash: 'h1' }, 'h2'), true);
});

test('unknown card id throws on writeCard; readCard returns null', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'db-stats-cache-'));
  try {
    assert.equal(readCard('nope', dataDir), null);
    assert.throws(() => writeCard('nope', { sourceHash: 'x', payload: {} }, dataDir), /unknown stats card id/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
