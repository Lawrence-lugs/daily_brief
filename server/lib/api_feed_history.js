// Persistent per-feed API health snapshots.
//
// Written by the brief API-refresh worker (source: "brief") and by the
// statistics API-feed card's live test (source: "live"). The statistics card
// reads this file instead of re-fetching the APIs on every page load.
//
// One snapshot per calendar day (UTC), last-writer-wins. Kept as a small JSON
// file under <dataDir>/stats/ so it survives restarts and needs no migration.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiProviderName } from './fetch/fetcher.js';

export const API_PROVIDER_ORDER = ['openalex', 'semanticscholar', 'ieeexplore'];
export const API_HISTORY_KEEP_DAYS = 60;
export const API_HISTORY_DISPLAY_DAYS = 30;

/** Path to the API-feed history file for a data directory. */
export function apiFeedHistoryPath(dataDir) {
  return join(dataDir, 'stats', 'api_feeds_history.json');
}

/** Read the history file. Missing/corrupt files become an empty history. */
export function readApiFeedHistory(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(apiFeedHistoryPath(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.runs || typeof raw.runs !== 'object') {
      return { version: 1, runs: {} };
    }
    return { version: 1, runs: raw.runs };
  } catch {
    return { version: 1, runs: {} };
  }
}

function trimErrorMessage(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 500) : null;
}

/**
 * Record one API refresh run. The results are the objects returned by
 * fetchApiFeedsDetailed(); only diagnostic metadata is persisted (never the
 * fetched items themselves).
 */
export function recordApiFeedRun(dataDir, results, {
  source = 'brief',
  at = new Date(),
  keepDays = API_HISTORY_KEEP_DAYS,
} = {}) {
  const date = at.toISOString().slice(0, 10);
  const feeds = (results ?? []).map((r) => {
    const fetcher = String(r.fetcher ?? '');
    return {
      name: String(r.name ?? fetcher ?? 'unknown'),
      fetcher,
      provider: String(r.provider ?? apiProviderName(fetcher)),
      ok: Boolean(r.ok),
      skipped: Boolean(r.skipped),
      itemCount: Number(r.itemCount) || 0,
      error: trimErrorMessage(r.error),
      ms: Number(r.ms) || 0,
    };
  });
  const snapshot = {
    date,
    source,
    at: at.toISOString(),
    durationMs: feeds.reduce((sum, feed) => sum + feed.ms, 0),
    feeds,
  };

  const history = readApiFeedHistory(dataDir);
  history.runs[date] = snapshot;

  // Keep the newest N calendar days.
  const dates = Object.keys(history.runs).sort();
  const excess = Math.max(0, dates.length - Math.max(1, keepDays));
  for (const old of dates.slice(0, excess)) delete history.runs[old];

  const dir = join(dataDir, 'stats');
  mkdirSync(dir, { recursive: true });
  const file = apiFeedHistoryPath(dataDir);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, runs: history.runs }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return snapshot;
}

function providerRank(key) {
  const index = API_PROVIDER_ORDER.indexOf(key);
  return index < 0 ? API_PROVIDER_ORDER.length : index;
}

/**
 * Build the payload consumed by the statistics card:
 * per-day provider totals plus the latest per-feed detail.
 */
export function buildApiFeedPayload(dataDir, { days = API_HISTORY_DISPLAY_DAYS } = {}) {
  const history = readApiFeedHistory(dataDir);
  const allDates = Object.keys(history.runs).sort();
  const windowDays = Math.max(1, Number(days) || API_HISTORY_DISPLAY_DAYS);
  const dates = allDates.slice(-windowDays);

  const providers = [];
  const seen = new Set();
  for (const date of dates) {
    for (const feed of history.runs[date]?.feeds ?? []) {
      const key = feed.fetcher || feed.provider;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      providers.push({ key, name: feed.provider || apiProviderName(key) });
    }
  }
  providers.sort((a, b) =>
    providerRank(a.key) - providerRank(b.key) || a.name.localeCompare(b.name));

  const rows = dates.map((date) => {
    const run = history.runs[date] ?? {};
    const feeds = Array.isArray(run.feeds) ? run.feeds : [];
    const providerCounts = {};
    for (const provider of providers) providerCounts[provider.key] = 0;
    for (const feed of feeds) {
      const key = feed.fetcher || feed.provider;
      if (key in providerCounts) providerCounts[key] += Number(feed.itemCount) || 0;
    }
    return {
      date,
      source: run.source ?? 'unknown',
      at: run.at ?? null,
      durationMs: Number(run.durationMs) || 0,
      providerCounts,
      totalItems: feeds.reduce((sum, feed) => sum + (Number(feed.itemCount) || 0), 0),
      ok: feeds.filter((feed) => feed.ok && !feed.skipped).length,
      failed: feeds.filter((feed) => !feed.ok && !feed.skipped).length,
      skipped: feeds.filter((feed) => feed.skipped).length,
    };
  });

  const latestDate = dates[dates.length - 1];
  const latestRun = latestDate ? history.runs[latestDate] : null;
  const latestFeeds = Array.isArray(latestRun?.feeds) ? latestRun.feeds : [];

  return {
    days: rows,
    providers,
    latest: latestRun ? {
      date: latestRun.date,
      source: latestRun.source,
      at: latestRun.at,
      durationMs: Number(latestRun.durationMs) || 0,
      feeds: latestFeeds,
      ok: latestFeeds.filter((feed) => feed.ok && !feed.skipped).length,
      failed: latestFeeds.filter((feed) => !feed.ok && !feed.skipped).length,
      skipped: latestFeeds.filter((feed) => feed.skipped).length,
    } : null,
    windowDays,
    recordedDays: allDates.length,
  };
}
