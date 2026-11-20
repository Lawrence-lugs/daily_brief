import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  apiFeedHistoryPath, buildApiFeedPayload, readApiFeedHistory, recordApiFeedRun,
} from '../lib/api_feed_history.js';

const results = [
  {
    name: 'OpenAlex — IEEE JSSC', fetcher: 'openalex', provider: 'OpenAlex',
    ok: true, skipped: false, itemCount: 10, items: [{ title: 'not persisted' }],
    age: {
      dated: 10, undated: 0, min: 1, median: 12.4, p90: 40, max: 84,
      buckets: { d0_7: 2, d7_30: 5, d30_90: 3, d90_plus: 0 },
    },
    error: null, errorName: null, envVar: null, ms: 100,
  },
  {
    name: 'IEEE Xplore — JSSC', fetcher: 'ieeexplore', provider: 'IEEE Xplore',
    ok: false, skipped: true, itemCount: 0, items: [],
    error: 'missing IEEE_XPLORE_API_KEY', errorName: null, envVar: 'IEEE_XPLORE_API_KEY', ms: 0,
  },
  {
    name: 'S2 — DSE', fetcher: 'semanticscholar', provider: 'Semantic Scholar',
    ok: false, skipped: false, itemCount: 0, items: [],
    error: 'HTTP 500', errorName: 'Error', envVar: null, ms: 50,
  },
];

test('recordApiFeedRun persists one snapshot per day without the fetched items', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-history-'));
  try {
    const at = new Date('2026-11-20T12:00:00Z');
    const snapshot = recordApiFeedRun(dataDir, results, { source: 'brief', at });
    assert.equal(snapshot.date, '2026-11-20');
    assert.equal(snapshot.source, 'brief');
    assert.equal(snapshot.feeds.length, 3);
    assert.equal(snapshot.durationMs, 150);
    assert.equal(snapshot.feeds[0].itemCount, 10);
    assert.equal(snapshot.feeds[0].age.median, 12.4);
    assert.equal(snapshot.feeds[0].age.buckets.d7_30, 5);
    assert.equal(snapshot.feeds[1].age, null);
    assert.ok(!('items' in snapshot.feeds[0]), 'items are not persisted');
    assert.equal(snapshot.feeds[2].error, 'HTTP 500');

    const onDisk = JSON.parse(readFileSync(apiFeedHistoryPath(dataDir), 'utf8'));
    assert.equal(onDisk.runs['2026-11-20'].feeds.length, 3);
    assert.ok(!JSON.stringify(onDisk).includes('not persisted'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('buildApiFeedPayload aggregates provider counts and latest run', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-history-'));
  try {
    recordApiFeedRun(dataDir, results, { source: 'brief', at: new Date('2026-11-18T12:00:00Z') });
    recordApiFeedRun(dataDir, [
      { ...results[0], itemCount: 20 },
      { ...results[2], ok: true, error: null, itemCount: 5 },
    ], { source: 'live', at: new Date('2026-11-20T12:00:00Z') });

    const payload = buildApiFeedPayload(dataDir);
    assert.deepEqual(payload.days.map((day) => day.date), ['2026-11-18', '2026-11-20']);
    assert.deepEqual(payload.providers.map((provider) => provider.key), [
      'openalex', 'semanticscholar', 'ieeexplore',
    ]);
    assert.equal(payload.days[0].providerCounts.openalex, 10);
    assert.equal(payload.days[0].providerAge.openalex, 12.4);
    assert.equal(payload.days[1].providerAge.openalex, 12.4);
    assert.equal(payload.latest.feeds[0].age.median, 12.4);
    assert.equal(payload.days[1].providerCounts.openalex, 20);
    assert.equal(payload.days[1].providerCounts.semanticscholar, 5);
    assert.equal(payload.days[1].providerCounts.ieeexplore, 0);
    assert.equal(payload.latest.source, 'live');
    assert.equal(payload.latest.ok, 2);
    assert.equal(payload.latest.failed, 0);
    assert.equal(payload.latest.skipped, 0);
    assert.equal(payload.recordedDays, 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('same day replaces the snapshot; old days are pruned', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-history-'));
  try {
    recordApiFeedRun(dataDir, [{ ...results[0], itemCount: 1 }], {
      source: 'brief', at: new Date('2026-11-20T01:00:00Z'),
    });
    recordApiFeedRun(dataDir, [{ ...results[0], itemCount: 2 }], {
      source: 'live', at: new Date('2026-11-20T02:00:00Z'),
    });
    const history = readApiFeedHistory(dataDir);
    assert.equal(history.runs['2026-11-20'].source, 'live');
    assert.equal(history.runs['2026-11-20'].feeds[0].itemCount, 2);

    for (let i = 0; i < 65; i++) {
      const at = new Date(Date.UTC(2026, 0, 1 + i));
      recordApiFeedRun(dataDir, [{ ...results[0], itemCount: i }], { at, keepDays: 60 });
    }
    const pruned = readApiFeedHistory(dataDir);
    assert.equal(Object.keys(pruned.runs).length, 60);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('corrupt or missing history yields an empty payload', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-history-'));
  try {
    const empty = buildApiFeedPayload(dataDir);
    assert.deepEqual(empty.days, []);
    assert.equal(empty.latest, null);
    assert.deepEqual(empty.providers, []);

    recordApiFeedRun(dataDir, results, { at: new Date('2026-11-20T00:00:00Z') });
    writeFileSync(apiFeedHistoryPath(dataDir), '{not json', 'utf8');
    assert.deepEqual(readApiFeedHistory(dataDir), { version: 1, runs: {} });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
