// Cluster members card: a per-cluster table of the fitted interest clusters.
// Each row is one cluster with the medoid name, the number of its interest members
// that are liked items, and the number of candidate_pool items assigned to it.
// Pool assignment mirrors the ranker (ranker/pipeline.js prepareCandidates): each
// candidate is assigned to its nearest medoid by cosine distance.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';
import { hydrateInterests, topDistances } from '../../../ranker/interests.js';
import { resolvePsFile } from '../../../ranker/pipeline.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function normId(rawId) {
  return String(rawId).startsWith('ps:') ? String(rawId) : `ps:${String(rawId)}`;
}

function openStore(dataDir) {
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  return new Store(resolve(dataDir, cfg.db_file ?? 'daily_brief.db'));
}

function readPerfect(dataDir) {
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  try {
    return JSON.parse(readFileSync(resolvePsFile(cfg.ranker ?? {}), 'utf8'));
  } catch {
    return [];
  }
}

export async function sourceHash(dataDir = defaultDataDir()) {
  const store = openStore(dataDir);
  try {
    const parts = [store.getState('fit_key') ?? '', store.getState('interests') ?? ''];
    return createHash('sha256').update(parts.join(':')).digest('hex');
  } finally {
    store.close();
  }
}

export async function generate(dataDir = defaultDataDir()) {
  const store = openStore(dataDir);
  try {
    const raw = store.getState('interests');
    if (!raw) throw new Error('no fitted interests stored: run a refit first');
    const getVec = (id) => {
      const emb = store.getEmbedding(id);
      if (!emb) throw new Error(`no embedding for cluster item ${id}`);
      return emb.vec;
    };
    const interests = hydrateInterests(raw, getVec);

    const perfect = readPerfect(dataDir);
    const perfectTitle = new Map(perfect.map((ps) => [normId(ps.id), ps.title]));
    const storyTitle = new Map();
    for (const r of store.db.prepare('SELECT item_id, headline FROM stories ORDER BY story_id').all()) {
      storyTitle.set(r.item_id, r.headline);
    }
    const poolTitle = new Map();
    for (const r of store.db.prepare('SELECT item_id, title FROM candidate_pool ORDER BY item_id').all()) {
      poolTitle.set(r.item_id, r.title);
    }
    const titleOf = (id) => {
      if (String(id).startsWith('ps:')) return perfectTitle.get(id) ?? id;
      return storyTitle.get(id) ?? poolTitle.get(id) ?? id;
    };

    const poolCount = new Map();
    for (const { item_id: id } of store.db.prepare('SELECT item_id FROM candidate_pool').all()) {
      const emb = store.getEmbedding(id);
      if (!emb) continue;
      const { cid } = topDistances(interests, emb.vec, 1)[0];
      poolCount.set(cid, (poolCount.get(cid) ?? 0) + 1);
    }

    const rows = interests.clusters.map((c) => {
      const members = c.members ?? [];
      return {
        cluster: c.id,
        medoid: c.medoid,
        medoidTitle: titleOf(c.medoid),
        likedCount: members.filter((id) => !String(id).startsWith('ps:')).length,
        poolCount: poolCount.get(c.id) ?? 0,
        size: c.size ?? members.length,
      };
    });
    rows.sort((a, b) => Number(a.cluster) - Number(b.cluster));
    return { clusters: rows, nClusters: rows.length };
  } finally {
    store.close();
  }
}
