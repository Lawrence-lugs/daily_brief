// Runs `server/lib/brief.js` main() in a child process (no preinstalled Python required; the server's
// event loop stays free so /api/job keeps answering while a generation runs).
// Exposes the job log for polling. brief.js writes its log to --log-file via util.LOG_FILE,
// and --progress-file via the Progress class. We tail both files like the old Python version.
//
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLogFile } from './util.js';

const BRIEF_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'brief_child.js');

/** Runs one brief in a child process, so its CPU-bound work never blocks the HTTP event loop
 *  (the client polls /api/job during a run; a blocked loop makes polls time out -> "lost contact"). */
export function forkRunBrief(script = BRIEF_CHILD) {
  return (flags) => new Promise((resolve, reject) => {
    const child = fork(script, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let settled = false;
    child.on('message', (msg) => {
      settled = true;
      if (msg && msg.error !== undefined) reject(new Error(msg.error));
      else resolve(msg?.exitCode ?? 1);
    });
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`brief child exited with code ${code}`)); }
    });
    child.send(flags);
  });
}

const POLL_MS = 500;
const TAIL_DEADLINE_MS = 15 * 60 * 1000;

export class JobRunner {
  /** @param {{cwd:string, progress?:boolean, runBrief?:(flags:object)=>Promise<number>}} o
   *  progress=false skips --progress-file. runBrief is injected for testing. */
  constructor({ cwd, dataDir = null, progress = true, runBrief = forkRunBrief() }) {
    Object.assign(this, { cwd, dataDir, useProgress: progress, runBrief });
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

    setLogFile(logFile);

    const jobFlags = {
      noLlm: flags.noLlm === true,
      noFetch: flags.noFetch === true,
      engine: flags.engine,
      dryRun: flags.dryRun === true,
      seed: flags.seed,
      logFile,
      progressFile: this.useProgress ? progressFile : null,
      refreshApiFeeds: flags.refreshApiFeeds === true,
      dataDir: this.dataDir,
    };

    this.state = {
      id: this.state.id + 1, status: 'running', exitCode: null, error: '', log: '',
      startedAt: Date.now(), progress: null,
    };

    // Fire-and-forget the brief run (mirrors the old child_process.spawn semantics).
    // #readLog polls via setInterval; runBrief's promise resolves updates status.
    this.runBrief(jobFlags).then((exitCode) => {
      this.state.exitCode = exitCode;
      this.state.status = exitCode === 0 ? 'done' : 'failed';
      if (exitCode !== 0) {
        this.state.error = `exit code ${exitCode}`;
      }
      this.#readLog(logFile, progressFile, this.state);
      this.#stopTail();
    }).catch((e) => {
      this.state.status = 'failed';
      this.state.error = `brief.js threw: ${e.message}`;
      this.#readLog(logFile, progressFile, this.state);
      this.#stopTail();
    });

    // Initial read + polling interval (mirrors the old setInterval tail).
    this.#readLog(logFile, progressFile, this.state);
    this.timer = setInterval(() => this.#readLog(logFile, progressFile, this.state), POLL_MS);

    return { ok: true, id: this.state.id };
  }

  #readLog(logFile, progressFile, s) {
    if (s !== this.state) return;
    try { s.log = readFileSync(logFile, 'utf8'); } catch { /* not created yet */ }
    try {
      const o = JSON.parse(readFileSync(progressFile, 'utf8'));
      if (o && o.v === 1 && typeof o.seq === 'number') s.progress = o;
    } catch { /* missing or mid-replace */ }
    if (s.status === 'running') return;
    this.#stopTail();
  }

  #stopTail() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.logDir) { try { rmSync(this.logDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    this.logDir = null;
  }

  /** Incremental view for the client. `since` / `pseq` are only honoured for the same job id. */
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
