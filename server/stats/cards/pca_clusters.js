// PCA clusters card: the interest clusters the LR model stored on its last fit (ranker_state
// 'interests', medoids + members), projected to 2D by PCA in a Python subprocess
// (simulate/experiments/pca_clusters.py). Nothing is re-clustered here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';
import { hydrateInterests } from '../../../ranker/interests.js';
import { resolvePsFile } from '../../../ranker/pipeline.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const PYTHON = process.env.PYTHON ?? 'python';

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

export async function sourceHash() {
  const store = openStore(defaultDataDir());
  try {
    const parts = [store.getState('fit_key') ?? '', store.getState('interests') ?? ''];
    return createHash('sha256').update(parts.join(':')).digest('hex');
  } finally {
    store.close();
  }
}

export async function generate() {
  const dataDir = defaultDataDir();
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
    if (ids.length < 3) throw new Error(`need at least 3 clustered items for PCA, got ${ids.length}`);
    const medoidIds = interests.clusters.map((c) => c.medoid);

    const input = JSON.stringify({ ids, titles, groups, vectors, clusterOf, medoidIds });
    const proc = spawn(PYTHON, ['-m', 'simulate.experiments.pca_clusters'], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdin.write(input);
    proc.stdin.end();

    const status = await new Promise((resolve) => proc.on('close', resolve));
    if (status !== 0) throw new Error(`python PCA projection exited ${status}: ${stderr.trim() || stdout.trim()}`);
    return JSON.parse(stdout);
  } finally {
    store.close();
  }
}
