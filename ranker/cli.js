// CLI entry point for ranker commands.
// stdout is reserved for the JSON of `select`; everything else goes to stderr.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { ensureEmbeddings, ensureFitted, prepareCandidates } from './pipeline.js';

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
  const cfg = loadConfig();
  if (args.seed) cfg.seed = parseInt(args.seed, 10);
  const store = new Store(DB_FILE);
  try {
    await ensureEmbeddings(store, cfg, { persist: true });
    const fitted = await ensureFitted(store, cfg, { persist: true });
    if (!fitted.interests) {
      console.error('[select] interests not built, exiting with code 3');
      process.exit(3);
    }
    const candidates = prepareCandidates(store, cfg, fitted, args.date, new Date());
    // TODO: selectBrief
    console.log(JSON.stringify({ primary: [], science: [] }));
  } finally {
    store.close();
  }
}

async function cmdSimulate(args) {
  const cfg = loadConfig();
  if (args.set) cfg = applyOverrides(cfg, args.set);
  if (args.runs) cfg.runs = parseInt(args.runs, 10);
  if (args.seed) cfg.seed = parseInt(args.seed, 10);
  const store = new Store(DB_FILE);
  try {
    await ensureFitted(store, cfg, { persist: false });
    const candidates = prepareCandidates(store, cfg, fitted, args.date, new Date());
    // TODO: simulate
    console.log(JSON.stringify({ runs: cfg.runs, summary: 'TODO' }));
  } finally {
    store.close();
  }
}

async function cmdEval(args) {
  const cfg = loadConfig();
  const store = new Store(DB_FILE);
  try {
    // TODO: eval
    console.log(JSON.stringify({ auc: 0, logLoss: 0 }));
  } finally {
    store.close();
  }
}

async function cmdInspect(args) {
  const cfg = loadConfig();
  const store = new Store(DB_FILE);
  try {
    // TODO: inspect
    console.log(JSON.stringify({ weights: [], clusters: [] }));
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