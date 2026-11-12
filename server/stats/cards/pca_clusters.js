// UMAP clusters card: projects the ranker's stored interest clusters to 2D
// using umap-js (pure JavaScript, no Python). Nothing is re-clustered here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';
import { hydrateInterests, topDistances } from '../../../ranker/interests.js';
import { resolvePsFile } from '../../../ranker/pipeline.js';
import { UMAP } from 'umap-js';

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
    const pool = store.db.prepare('SELECT item_id FROM candidate_pool ORDER BY item_id').all().map((r) => r.item_id);
    const parts = [store.getState('fit_key') ?? '', store.getState('interests') ?? '', pool.join(',')];
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

    const ids = [], titles = [], groups = [], vectors = [], clusterOf = [];
    for (const cluster of interests.clusters) {
      for (const id of cluster.members) {
        const emb = store.getEmbedding(id);
        if (!emb) continue;
        ids.push(id);
        groups.push(perfectTitle.has(id) ? 'perfect' : 'liked');
        titles.push(perfectTitle.get(id) ?? storyTitle.get(id) ?? id);
        vectors.push(Array.from(emb.vec));
        clusterOf.push(cluster.id);
      }
    }
    const seen = new Set(ids);
    const mulberry32 = (seed) => () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed, seed ^ (seed >>> 15));
      t = (t + Math.imul(t, t ^ (t >>> 7))) | 0;
      t = Math.imul(t ^ (t >>> 16), t);
      t = (t + Math.imul(t ^ (t >>> 16), t >>> 15)) | 0;
      return (t >>> 0) / 4294967296;
    };
    const poolCandidates = [];
    for (const r of store.db.prepare('SELECT item_id, title FROM candidate_pool ORDER BY item_id').all()) {
      if (seen.has(r.item_id)) continue;
      const emb = store.getEmbedding(r.item_id);
      if (!emb) continue;
      poolCandidates.push({ id: r.item_id, title: r.title ?? r.item_id, vec: emb.vec });
    }
    const POOL_SAMPLE = 1024;
    if (poolCandidates.length > POOL_SAMPLE) {
      const rand = mulberry32(42);
      for (let i = poolCandidates.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [poolCandidates[i], poolCandidates[j]] = [poolCandidates[j], poolCandidates[i]];
      }
      poolCandidates.length = POOL_SAMPLE;
    }
    for (const p of poolCandidates) {
      ids.push(p.id);
      groups.push('pool');
      titles.push(p.title);
      vectors.push(Array.from(p.vec));
      clusterOf.push(topDistances(interests, p.vec, 1)[0].cid);
    }
    if (ids.length < 3) throw new Error(`need at least 3 clustered items for UMAP, got ${ids.length}`);
    const medoidIds = interests.clusters.map((c) => c.medoid);

    const nNeighbors = Math.min(15, Math.max(2, ids.length - 1));
    const reducer = new UMAP({ nComponents: 2, nNeighbors, minDist: 0.1, random: mulberry32(42) });
    const Z = reducer.fit(vectors);

    const indexOf = {};
    for (let i = 0; i < ids.length; i++) indexOf[ids[i]] = i;

    const medoids = [];
    for (let c = 0; c < medoidIds.length; c++) {
      const medoidId = medoidIds[c];
      const i = indexOf[medoidId];
      if (i === undefined) continue; // medoid has no embedding / isn't projected
      medoids.push({
        cluster: c,
        id: medoidId,
        title: titles[i],
        x: Number(Z[i][0]),
        y: Number(Z[i][1]),
        size: intCount(clusterOf, c, groups),
      });
    }

    const points = [];
    for (let i = 0; i < ids.length; i++) {
      points.push({
        id: ids[i],
        title: titles[i],
        group: groups[i],
        cluster: clusterOf[i],
        x: Number(Z[i][0]),
        y: Number(Z[i][1]),
      });
    }

    return { points, medoids, k: medoidIds.length, explainedVariance: null };
  } finally {
    store.close();
  }
}

function intCount(arr, v, groups) { let n = 0; for (let i = 0; i < arr.length; i++) if (arr[i] === v && groups[i] !== 'pool') n++; return n; }
