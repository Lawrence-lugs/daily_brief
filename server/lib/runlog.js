/** Run log shared with the Node ranker: one JSONL file per run under logs/ranker/.

Level comes from RANKER_DEBUG with the same rules as ranker/debuglog.js:
unset/''/0/false => summary, 1/true => detail, summary|detail|trace by name.
Summary events are always written.
*/
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const LEVELS = { summary: 1, detail: 2, trace: 3 };
const _ALIASES = { '': 'summary', '0': 'summary', 'false': 'summary', '1': 'detail', 'true': 'detail' };

export function resolveLevel(raw) {
  if (raw === undefined || raw === null) raw = process.env.RANKER_DEBUG ?? '';
  const v = String(raw).trim().toLowerCase();
  if (v in _ALIASES) return _ALIASES[v];
  if (v in LEVELS) return v;
  throw new Error(`RANKER_DEBUG must be summary|detail|trace (got ${String(raw)})`);
}

export function nowIso() {
  return new Date().toISOString();
}

export class RunLog {
  constructor(root, cmd, header = {}) {
    this.level = resolveLevel();
    this.enabled = this.level !== 'summary';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    this.runId = process.env.RANKER_RUN_ID || `${stamp}-${cmd}-${Math.random().toString(16).slice(2, 8)}`;
    const logDir = path.join(root, 'logs', 'ranker');
    mkdirSync(logDir, { recursive: true });
    this.path = path.join(logDir, `${this.runId}.jsonl`);
    this._seq = 0;
    this._closed = false;
    // Open file (create/truncate)
    writeFileSync(this.path, '', 'utf8');
    this.event('header', { cmd, ...header, level: this.level, pid: process.pid, started: nowIso() });
  }

  want(level = 'summary') {
    return LEVELS[level] <= LEVELS[this.level];
  }

  event(kind, data = {}, level = 'summary') {
    if (this._closed || !this.want(level)) return;
    const rec = { src: 'py', seq: this._seq, level, kind, data: data || {} };
    this._seq += 1;
    try {
      appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf8');
    } catch {
      // never let run-logging break a generation
    }
  }

  childEnv() {
    return { ...process.env, RANKER_RUN_ID: this.runId };
  }

  close() {
    if (this._closed) return;
    this.event('end', { t: nowIso() });
    this._closed = true;
  }
}
