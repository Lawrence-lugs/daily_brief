// Runs `python src/brief.py` as a single background job and exposes its log for polling.
// Port of the old dataviewjs logic: brief.py writes its log to --log-file (the detached
// "API background refresh" process appends to the SAME file), so we tail that file rather than
// stderr, and keep tailing after the main process exits until the background refresh finishes.
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

export class JobRunner {
  constructor({ python, script, cwd }) {
    Object.assign(this, { python, script, cwd });
    this.state = { id: 0, status: 'idle', exitCode: null, error: '', log: '', startedAt: null };
    this.timer = null;
    this.logDir = null;
  }

  /** @returns {{ok:true,id:number}|{ok:false,reason:'busy'}} */
  start(flags = {}) {
    if (this.state.status === 'running') return { ok: false, reason: 'busy' };
    this.#stopTail();
    this.logDir = mkdtempSync(path.join(tmpdir(), 'daily-brief-'));
    const logFile = path.join(this.logDir, 'run.log');
    const boolArgs = Object.entries(BOOL_FLAGS).filter(([k]) => flags[k]).map(([, v]) => v);
    const valueArgs = Object.entries(VALUE_FLAGS).flatMap(([k, v]) => flags[k] ? [v, String(flags[k])] : []);
    const args = [this.script, ...boolArgs, ...valueArgs, '--log-file', logFile];
    const s = this.state = { id: this.state.id + 1, status: 'running', exitCode: null, error: '', log: '', startedAt: Date.now() };
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
      this.#readLog(logFile, s);
    });
    this.timer = setInterval(() => this.#readLog(logFile, s), POLL_MS);
    return { ok: true, id: s.id };
  }

  #readLog(logFile, s) {
    if (s !== this.state) return; // a newer job replaced us
    try { s.log = readFileSync(logFile, 'utf8'); } catch { /* not created yet */ }
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

  /** Incremental view for the client. `since` is only honoured for the same job id. */
  view(jobId, since) {
    const s = this.state;
    const same = jobId === s.id;
    const off = same ? Math.max(0, Math.min(Number(since) || 0, s.log.length)) : 0;
    return { id: s.id, status: s.status, exitCode: s.exitCode, error: s.error,
      reset: !same, log: s.log.slice(off), offset: s.log.length };
  }
}
