// Run log for the ranker CLI: one JSON line per event in logs/ranker/<runId>.jsonl (project root).
// Summary is always written; detail and trace need --debug[=level] or RANKER_DEBUG.
// Never writes to stdout: `select` stdout is the JSON contract read by src/brief.py.
// Writes are synchronous so process.exit() does not drop lines.
import { openSync, writeSync, closeSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = resolve(__dirname, '..');
const LOG_DIR = join(ROOT, 'logs', 'ranker');

export const LEVELS = { summary: 1, detail: 2, trace: 3 };

const CODE_FILES = {
  model: ['model.js'],
  trainer: ['trainer.js'],
  features: ['features.js'],
  interests: ['interests.js', 'agglo.js'],
};

let codeCache = null;
/** SHA-1 of each cache-relevant module's source. Any edit, comments included, changes its hash. */
export function codeHashes() {
  codeCache ??= Object.fromEntries(Object.entries(CODE_FILES).map(([name, files]) => [
    name,
    createHash('sha1').update(files.map((f) => readFileSync(join(__dirname, f))).join('')).digest('hex'),
  ]));
  return codeCache;
}

/** `flag` is the --debug value (undefined when absent), otherwise RANKER_DEBUG decides. */
export function resolveLevel(flag, env = process.env.RANKER_DEBUG) {
  const v = flag ?? env ?? '';
  if (v === '' || v === '0' || v === 'false') return 'summary';
  if (v === '1' || v === 'true') return 'detail';
  if (!Object.hasOwn(LEVELS, v)) throw new Error(`unknown debug level "${v}" (use summary, detail or trace)`);
  return v;
}

/** Pulls --debug or --debug=<level> out of argv, because parseArgs requires a value for string options. */
export function takeDebugFlag(argv) {
  let flag;
  const rest = argv.filter((a) => {
    if (a === '--debug') { flag = 'detail'; return false; }
    if (a.startsWith('--debug=')) { flag = a.slice('--debug='.length); return false; }
    return true;
  });
  return { argv: rest, flag };
}

function gitInfo() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  try {
    return { sha: git(['rev-parse', 'HEAD']).trim(), dirtyRanker: git(['status', '--porcelain', '--', 'ranker']).trim() !== '' };
  } catch {
    return { sha: null, dirtyRanker: null };
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

/** Used when a caller does not open a run, so pipeline functions can always call run.event(). */
export const NULL_RUN = { runId: null, path: null, level: 'off', enabled: false, want: () => false, event() {}, close() {} };

/**
 * @param {{cmd:string, date?:string|null, seed?:number|null, config?:object, flag?:string, argv?:string[]}} o
 * @returns {{runId, path, level, enabled, want(level), event(kind, data?, level?), close(code?)}}
 *   enabled: detail or trace is on, so callers may skip building large payloads otherwise.
 *   RANKER_RUN_ID joins an existing run file (set by src/brief.py for the node subprocess).
 */
export function openRun({ cmd, date = null, seed = null, config = null, flag, argv = process.argv.slice(2) }) {
  const level = resolveLevel(flag);
  const runId = process.env.RANKER_RUN_ID || `${stamp()}-${cmd}-${randomBytes(3).toString('hex')}`;
  mkdirSync(LOG_DIR, { recursive: true });
  const path = join(LOG_DIR, `${runId}.jsonl`);
  const fd = openSync(path, 'a');
  let seq = 0, closed = false;
  const want = (l) => LEVELS[l] <= LEVELS[level];
  const write = (rec) => {
    try { writeSync(fd, JSON.stringify(rec) + '\n'); } catch (e) { console.error(`[log] write failed: ${e.message}`); }
  };
  const run = {
    runId, path, level, enabled: level !== 'summary', want,
    event(kind, data = {}, l = 'summary') {
      if (closed || !want(l)) return;
      write({ src: 'node', seq: seq++, level: l, kind, data });
    },
    close(code = null) {
      if (closed) return;
      write({ src: 'node', seq: seq++, level: 'summary', kind: 'end', data: { exitCode: code, t: new Date().toISOString() } });
      closed = true;
      closeSync(fd);
    },
  };
  process.once('exit', (code) => run.close(code));
  run.event('header', {
    cmd, date, seed, argv, level, config,
    git: gitInfo(), codeHashes: codeHashes(),
    node: process.version, pid: process.pid, started: new Date().toISOString(),
  });
  return run;
}
