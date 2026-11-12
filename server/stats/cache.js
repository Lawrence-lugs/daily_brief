// Persistence for statistics card results: one JSON file per card under
// <data-dir>/stats/<cardId>.json. Survives a server restart.
// ESM, matching the server's module style ("type": "module").
import { writeFileSync, renameSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../../user/datadir.js';

const CARD_IDS = new Set(['feeds', 'pv_hist', 'lr_metrics', 'pca_clusters']);

/** Resolve the stats directory, creating it if needed. */
function statsDir(dataDir) {
  const dir = join(dataDir, 'stats');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function cardFile(dataDir, cardId) {
  if (!CARD_IDS.has(cardId)) throw new Error(`unknown stats card id: ${cardId}`);
  return join(statsDir(dataDir), `${cardId}.json`);
}

/** Read a stored card object, or null if absent / unreadable. */
export function readCard(cardId, dataDir = defaultDataDir()) {
  try {
    const raw = readFileSync(cardFile(dataDir, cardId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a card atomically: write <file>.tmp, then rename. Sets generatedAt to now. */
export function writeCard(cardId, { sourceHash, payload }, dataDir = defaultDataDir()) {
  const file = cardFile(dataDir, cardId);
  const tmp = `${file}.tmp.${process.pid}`;
  const stored = {
    cardId,
    generatedAt: new Date().toISOString(),
    sourceHash,
    payload,
  };
  writeFileSync(tmp, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return stored;
}

/** True if the stored card is null or its sourceHash differs from the current one. */
export function isOutdated(stored, currentSourceHash) {
  if (!stored) return true;
  return stored.sourceHash !== currentSourceHash;
}

export { CARD_IDS };
