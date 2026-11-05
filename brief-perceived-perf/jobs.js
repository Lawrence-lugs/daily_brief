// Runs `python src/brief.py` as a single background job and exposes its log for polling.
// Port of the old dataviewjs logic: brief.py writes its log to --log-file (the detached
// "API background refresh" process appends to the SAME file), so we tail that file rather than
// stderr, and keep tailing after the main process exits until the background refresh finishes.
//
// NEW: brief.py also writes --progress-file (see src/progress.py). It is re-read on every tick and
// kept in state.progress; view() hands it to the caller only when its `seq` changed since the
// caller's last poll (`pseq`), so idle polls stay tiny.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const POLL_MS = 500;
const TAIL_DEADLINE_MS = 15 * 60 * 1000;
// Boolean flags (no value)
const BOOL_FLAGS = { noLlm: '--no-llm', noFetch: '--no-fetch' };
// Flags that take a value
const VALUE_FLAGS = { engine: '--engine' };

function readProgress(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && o.v === 1 && typeof o.seq === 'number' ? o : null;
  } catch { return null; }   // missing, or caught mid-replace on Windows: keep the previous one
}

export class JobRunner {
  /** @param {{python:string, script:string, cwd:string, progress?:boolean}} o
   *  progress=false skips --progress-file (use until brief.py supports it). */
  constructor({ python, script, cwd, progress = true }) {
    Object.assign(this, { python, script, cwd, useProgress: progress });
    this.state = { id: 0, status: 'idle', exitCode: null, error: '', log: '', startedAt: null, progress: null };
    this.timer = null;
    this.logDir = null;
  }

  /** @returns {{ok:true,id:number}|{ok:false,reason:'busy'}} */
  start(flags = {}) {
    if (this.state.status === 'running') return { ok: false, reason: 'busy' };
    this.#stopTail();
    this.logDir = mkdtempSync(path.join(tmpdir(), 'daily-brief-'));
    const logFile = path.join(this.logDir, 'run.log');
    const progressFile = path.join(this.logDir, 'progress.json');
    const boolArgs = Object.entries(BOOL_FLAGS).filter(([k]) => flags[k]).map(([, v]) => v);
    const valueArgs = Object.entries(VALUE_FLAGS).flatMap(([k, v]) => flags[k] ? [v, String(flags[k])] : []);
    const progArgs = this.useProgress ? ['--progress-file', progressFile] : [];
    const args = [this.script, ...boolArgs, ...valueArgs, '--log-file', logFile, ...progArgs];
    const s = this.state = { id: this.state.id + 1, status: 'running', exitCode: null, error: '', log: '',
      startedAt: Date.now(), progress: null };
    let stderrTail = '';
    let child;
    try {
      child = spawn(this.python, args, { cwd: this.cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      s.status = 'failed'; s.error = String(e.message ?? e);
      return { ok: true, id: s.id };
    }
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    child.on('error', (e) => { s.status = 'failed'; s.error = `cannot start ${this.python}: ${e.message}`; });
    child.on('close', (code) => {
      if (s.status === 'failed') return; // spawn error already reported
      s.exitCode = code;
      s.status = code === 0 ? 'done' : 'failed';
      if (code !== 0) s.error = stderrTail.trim().split('\n').slice(-2).join(' ');
      this.#readLog(logFile, progressFile, s);
    });
    this.timer = setInterval(() => this.#readLog(logFile, progressFile, s), POLL_MS);
    return { ok: true, id: s.id };
  }

  #readLog(logFile, progressFile, s) {
    if (s !== this.state) return; // a newer job replaced us
    try { s.log = readFileSync(logFile, 'utf8'); } catch { /* not created yet */ }
    const p = readProgress(progressFile);
    if (p) s.progress = p;
    if (s.status === 'running') return;
    // Main process is finished. Keep tailing only while the detached API refresh is still going.
    const bgStarted = s.log.includes('API background refresh started');
    const bgDone = s.log.includes('API background refresh complete');
    if (!bgStarted || bgDone || Date.now() - s.startedAt > TAIL_DEADLINE_MS) this.#stopTail();
  }

  #stopTail() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.logDir) { try { rmSync(this.logDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    this.logDir = null;
  }

  /** Incremental view for the client. `since` / `pseq` are only honoured for the same job id.
   *  `progress` is the raw progress object, or null when unchanged (seq === pseq) or not written yet. */
  view(jobId, since, pseq) {
    const s = this.state;
    const same = jobId === s.id;
    const off = same ? Math.max(0, Math.min(Number(since) || 0, s.log.length)) : 0;
    const seen = same && pseq !== null && pseq !== undefined && pseq !== '' ? Number(pseq) : -1;
    const progress = s.progress && s.progress.seq !== seen ? s.progress : null;
    return { id: s.id, status: s.status, exitCode: s.exitCode, error: s.error,
      reset: !same, log: s.log.slice(off), offset: s.log.length, progress };
  }
}
