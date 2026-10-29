// CLI entry point for ranker commands.
// stdout is reserved for the JSON of `select`; everything else goes to stderr.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { ensureEmbeddings, ensureFitted, prepareCandidates, evalModel } from './pipeline.js';
import { selectBrief, mulberry32 } from './sampler.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CONFIG_FILE = resolve(__dirname, '..', 'config.json');
const DB_FILE = resolve(__dirname, '..', 'daily_brief.db');

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).ranker || {};
}

function applyOverrides(cfg, overrides) {
  // overrides: ['a.b=c', 'x.y=2']
  for (const ov of overrides) {
    const [path, val] = ov.split('=');
    if (!val) continue;
    let parsed;
    try {
      parsed = JSON.parse(val);
    } catch {
      parsed = val;
    }
    const keys = path.split('.');
    let o = cfg;
    for (let i = 0; i < keys.length - 1; i++) {
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = parsed;
  }
  return cfg;
}

async function cmdEmbed(args) {
  const cfg = loadConfig();
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
  } finally {
    store.close();
  }
}

async function cmdRefit(args) {
  const cfg = loadConfig();
  if (args.force) cfg.force = true;
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
    const result = await ensureFitted(store, cfg, { persist: true, force: args.force });
    console.error(`fitKey: ${result.fitKey}`);
    console.error(`fromCache: ${result.fromCache}`);
  } finally {
    store.close();
  }
}

async function cmdSelect(args) {
  let cfg = loadConfig();
  if (args.set) cfg = applyOverrides(cfg, args.set);
  if (args.seed) cfg.seed = parseInt(args.seed, 10);
  if (!args.date) {
    console.error('select requires --date D');
    process.exit(1);
  }
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
    const fitted = await ensureFitted(store, cfg, { persist: true });
    if (!fitted.interests) {
      console.error('[select] interests not built, exiting with code 3');
      process.exit(3);
    }
    // Use deterministic time (noon on dateKey) for age calculation so same seed = same output
    const now = new Date(args.date + 'T12:00:00.000Z');
    const candidates = prepareCandidates(store, cfg, fitted, args.date, now);
    const rng = mulberry32(cfg.seed ?? Date.now());
    const out = selectBrief(candidates, cfg.sampling, rng);
    // Output format: { desk: [{id, mode, p, V, cluster, core}] }
    const result = {};
    for (const [desk, items] of Object.entries(out)) {
      result[desk] = items.map((c) => ({
        id: c.id,
        mode: c.mode,
        p: c.p,
        V: c.V,
        cluster: c.cluster,
        core: c.core,
      }));
    }
    console.log(JSON.stringify(result));
  } finally {
    store.close();
  }
}

async function cmdSimulate(args) {
  const cfg = loadConfig();
  if (args.set) cfg = applyOverrides(cfg, args.set);
  if (args.runs) cfg.runs = parseInt(args.runs, 10);
  if (args.seed) cfg.seed = parseInt(args.seed, 10);
  if (!args.date) {
    console.error('simulate requires --date D');
    process.exit(1);
  }
  const store = new Store(DB_FILE);
  try {
    const fittedResult = await ensureFitted(store, cfg, { persist: false });
    const now = new Date(args.date + 'T12:00:00.000Z');
    const candidates = prepareCandidates(store, cfg, fittedResult, args.date, now);
    const { simulate } = await import('./simulate.js');
    const result = simulate(candidates, cfg.sampling, cfg.runs ?? 200, cfg.seed ?? 1);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

async function cmdEval(args) {
  const cfg = loadConfig();
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
    const results = await evalModel(store, cfg, { testFrac: args.testFrac ? parseFloat(args.testFrac) : 0.2 });
    console.log(JSON.stringify(results, null, 2));
  } finally {
    store.close();
  }
}

async function cmdInspect(args) {
  const cfg = loadConfig();
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
    const fitted = await ensureFitted(store, cfg, { persist: true });
    if (!fitted.interests) {
      console.error('[inspect] interests not built');
      process.exit(3);
    }
    
    // Get medoid titles from embeddings or pool/stories
    const embById = new Map((store.getAllEmbeddings() || []).map((e) => [e.item_id, e]));
    const poolItems = store.getPool();
    const poolById = new Map(poolItems.map((p) => [p.item_id, p]));
    
    function getMedoidTitle(id) {
      if (id.startsWith('ps:')) {
        // Perfect sample - get from perfect_samples.json
        const psId = id.slice(3);
        const ps = (JSON.parse(readFileSync(cfg.perfect_samples_file || 'perfect_samples.json', 'utf8')) || [])
          .find((p) => p.id === psId);
        return ps ? ps.title : id;
      }
      const poolItem = poolById.get(id);
      if (poolItem) return poolItem.title;
      return id;
    }
    
    // Clusters
    const clusters = fitted.interests.clusters.map((c) => ({
      id: c.id,
      medoid: c.medoid,
      medoidTitle: getMedoidTitle(c.medoid),
      size: c.size,
      core: c.core,
      stopHeight: fitted.interests.stopHeight,
    }));
    
    // Model weights
    const weights = fitted.model ? fitted.model.weights() : [];
    const topPos = weights.filter((w) => w.w > 0).sort((a, b) => b.w - a.w).slice(0, 20);
    const topNeg = weights.filter((w) => w.w < 0).sort((a, b) => a.w - b.w).slice(0, 20);
    
    console.log(JSON.stringify({
      clusters,
      weights: { topPositive: topPos, topNegative: topNeg },
    }, null, 2));
  } finally {
    store.close();
  }
}

const commands = {
  embed: cmdEmbed,
  refit: cmdRefit,
  select: cmdSelect,
  simulate: cmdSimulate,
  eval: cmdEval,
  inspect: cmdInspect,
};

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      force: { type: 'boolean', short: 'f' },
      seed: { type: 'string' },
      date: { type: 'string', short: 'd' },
      runs: { type: 'string' },
      set: { type: 'string', multiple: true },
      testFrac: { type: 'string' },
    },
  });

  const cmd = positionals[0];
  if (!cmd || !commands[cmd]) {
    console.error('Usage: node cli.js <command> [options]');
    console.error('Commands: embed, refit [--force], select --date D [--seed N], simulate [--runs N] [--seed N] [--set a.b=v...], eval, inspect');
    process.exit(1);
  }

  // Convert values to args object
  const args = { ...values };
  if (positionals[1]) args.date = positionals[1]; // allow positional date for select

  await commands[cmd](args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});