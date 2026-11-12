// Statistics page routes and card registry.
// Generate calls live under RESTRICTED_PREFIX (Traefik enforces auth there).
// Read calls live under /api/stats/ and stay public.
// ESM, matching the server's module style ("type": "module").
import { readCard, writeCard, isOutdated } from './cache.js';
import { defaultDataDir } from '../../user/datadir.js';
import { loadConfig } from '../../user/config.js';
import { Store } from '../../ranker/store.js';
import { NULL_RUN } from '../../ranker/debuglog.js';
import { sourceHash as feedsSourceHash, generate as feedsGenerate } from './cards/feeds.js';
import { sourceHash as pvHistSourceHash, generate as pvHistGenerate } from './cards/pv_hist.js';
import { sourceHash as lrMetricsSourceHash, generate as lrMetricsGenerate } from './cards/lr_metrics.js';
import { sourceHash as pcaClustersSourceHash, generate as pcaClustersGenerate } from './cards/pca_clusters.js';
import { sourceHash as clustersSourceHash, generate as clustersGenerate } from './cards/clusters.js';

import { resolve } from 'node:path';

export const RESTRICTED_PREFIX = '/api/restricted';

const CARDS = {
  feeds: { sourceHash: feedsSourceHash, generate: feedsGenerate },
  pv_hist: { sourceHash: pvHistSourceHash, generate: pvHistGenerate },
  lr_metrics: { sourceHash: lrMetricsSourceHash, generate: lrMetricsGenerate },
  pca_clusters: { sourceHash: pcaClustersSourceHash, generate: pcaClustersGenerate },
  clusters: { sourceHash: clustersSourceHash, generate: clustersGenerate },
};

// In-memory guard: a card can only generate once at a time (409 otherwise).
const generating = new Set();

function dbPath(dataDir) {
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  return resolve(dataDir, cfg.db_file ?? 'daily_brief.db');
}

function storeFor(dataDir = defaultDataDir()) {
  return new Store(dbPath(dataDir));
}

/** Resolve a card by id. Returns the card module or undefined. */
export function resolveCard(cardId) {
  return CARDS[cardId];
}

/** GET /api/stats/:cardId -> { card, outdated, currentSourceHash } or null if unknown card. */
export async function getStats(cardId, dataDir = defaultDataDir()) {
  const card = CARDS[cardId];
  if (!card) return null;
  const stored = readCard(cardId, dataDir);
  const currentSourceHash = await card.sourceHash(dataDir);
  return { card: stored, outdated: isOutdated(stored, currentSourceHash), currentSourceHash };
}

/** POST /api/restricted/stats/:cardId/generate -> stored card object. Throws on error (caller sets status). */
export async function generateStats(cardId, dataDir = defaultDataDir()) {
  const card = CARDS[cardId];
  if (!card) throw Object.assign(new Error('unknown stats card'), { status: 404 });
  if (generating.has(cardId)) throw Object.assign(new Error('a generation is already running for this card'), { status: 409 });
  generating.add(cardId);
  try {
    const currentSourceHash = await card.sourceHash(dataDir);
    const payload = await card.generate(dataDir);
    return writeCard(cardId, { sourceHash: currentSourceHash, payload }, dataDir);
  } finally {
    generating.delete(cardId);
  }
}

export { storeFor, NULL_RUN };
