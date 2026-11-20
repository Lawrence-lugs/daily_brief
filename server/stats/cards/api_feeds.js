// API feed health card.
//
// The daily chart comes from stats/api_feeds_history.json, which the brief's
// detached API-refresh worker records automatically (source: "brief"). The
// card's "Test APIs now" action runs the same fetchers on demand (source:
// "live") and records today's counts, then rebuilds the card.
//
// Live tests only count results; they do not upsert items into the candidate
// pool (normal brief generation already does that).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { fetchApiFeedsDetailed } from '../../lib/fetch/fetcher.js';
import {
  apiFeedHistoryPath, buildApiFeedPayload, recordApiFeedRun,
} from '../../lib/api_feed_history.js';

// Side-effect imports register the API fetchers used by a live test.
import '../../lib/fetch/semanticscholar.js';
import '../../lib/fetch/ieeexplore.js';
import '../../lib/fetch/openalex.js';

/** Hash the API source configuration plus the history file state. */
export async function sourceHash(dataDir = defaultDataDir()) {
  let sources = '';
  try { sources = readFileSync(resolve(dataDir, 'sources.json'), 'utf8'); } catch {}

  let history = '';
  try {
    const stat = statSync(apiFeedHistoryPath(dataDir));
    history = `${stat.mtimeMs}:${stat.size}`;
  } catch {}

  return createHash('sha256').update(sources).update('|').update(history).digest('hex');
}

/**
 * Build the card payload from recorded runs.
 * @param {string} dataDir
 * @param {{live?: boolean, fetchDetailed?: Function}} options
 */
export async function generate(dataDir = defaultDataDir(), {
  live = false,
  fetchDetailed = fetchApiFeedsDetailed,
} = {}) {
  if (live) {
    const cfg = loadConfig(dataDir, 'config.json') ?? {};
    const src = loadConfig(dataDir, 'sources.json') ?? {};
    const results = await fetchDetailed(cfg, src, { noCache: true });
    recordApiFeedRun(dataDir, results, { source: 'live' });
  }
  return buildApiFeedPayload(dataDir);
}
