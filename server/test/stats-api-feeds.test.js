import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generate, sourceHash } from '../stats/cards/api_feeds.js';
import { recordApiFeedRun } from '../lib/api_feed_history.js';

const openalex = {
  name: 'OpenAlex — IEEE JSSC', fetcher: 'openalex', provider: 'OpenAlex',
  ok: true, skipped: false, itemCount: 12, items: [{}],
  error: null, errorName: null, envVar: null, ms: 100,
};

test('generate builds the card from recorded history', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-card-'));
  try {
    writeFileSync(join(dataDir, 'sources.json'), JSON.stringify({ feeds: { api: { openalex: [] } } }));
    recordApiFeedRun(dataDir, [{ ...openalex, itemCount: 5 }], {
      source: 'brief', at: new Date('2026-11-19T12:00:00Z'),
    });
    recordApiFeedRun(dataDir, [{ ...openalex, itemCount: 9 }], {
      source: 'live', at: new Date('2026-11-20T12:00:00Z'),
    });

    const payload = await generate(dataDir);
    assert.deepEqual(payload.days.map((day) => day.date), ['2026-11-19', '2026-11-20']);
    assert.equal(payload.days[0].providerCounts.openalex, 5);
    assert.equal(payload.days[1].providerCounts.openalex, 9);
    assert.equal(payload.latest.source, 'live');
    assert.equal(payload.latest.feeds[0].itemCount, 9);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('generate({live:true}) fetches, records today, and rebuilds the card', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-card-'));
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({}));
    writeFileSync(join(dataDir, 'sources.json'), JSON.stringify({ feeds: { api: {} } }));
    let calls = 0;
    let fetchOptions = null;
    const fakeFetch = async (cfg, src, options) => {
      calls += 1;
      fetchOptions = options;
      return [{ ...openalex, itemCount: 3 }];
    };

    const payload = await generate(dataDir, { live: true, fetchDetailed: fakeFetch });
    assert.equal(calls, 1);
    assert.equal(fetchOptions.noCache, true);
    assert.equal(payload.latest.source, 'live');
    assert.equal(payload.latest.feeds.length, 1);
    assert.equal(payload.latest.feeds[0].itemCount, 3);
    assert.equal(payload.days.at(-1).providerCounts.openalex, 3);
    assert.equal(payload.latest.date, new Date().toISOString().slice(0, 10));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sourceHash tracks the sources file', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-card-'));
  try {
    const file = join(dataDir, 'sources.json');
    writeFileSync(file, JSON.stringify({ feeds: { api: { openalex: [] } } }));
    const before = await sourceHash(dataDir);
    writeFileSync(file, JSON.stringify({
      feeds: { api: { openalex: [{ name: 'new', kind: 'api', fetcher: 'openalex' }] } },
    }));
    const after = await sourceHash(dataDir);
    assert.notEqual(before, after);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
