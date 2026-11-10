import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobRunner } from '../lib/jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock runBrief that mimics brief.js writing progress.json + run.log
function makeMockRunBrief({ fail = false, phases = ['selecting', 'editing', 'done'] } = {}) {
  return async (flags) => {
    const { logFile, progressFile } = flags;
    let logContent = '';
    for (const phase of phases) {
      logContent += `${phase}\n`;
      writeFileSync(logFile, logContent);
      if (progressFile) {
        const seq = phases.indexOf(phase) + 1;
        const tmp = progressFile + '.tmp';
        writeFileSync(tmp, JSON.stringify({
          v: 1, seq, phase, engine: 'lr', t0: 1,
          desks: { primary: { title: 'P', n: 1, stage: phase === 'editing' ? 'raw' : 'pending', working: phase === 'editing', deck: '', items: [] } },
        }));
        renameSync(tmp, progressFile);
      }
      await sleep(800); // long enough for the 500ms poller to observe, short enough for tests
    }
    if (fail) return 3;
    return 0;
  };
}

async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(60); } throw new Error('timeout'); }

test('progress is exposed, only re-sent when seq changed, and job completes', async () => {
  const runBrief = makeMockRunBrief();
  const jr = new JobRunner({ cwd: process.cwd(), runBrief });
  const { id } = jr.start({ engine: 'lr' });
  const v1 = await until(() => { const v = jr.view(id, 0, -1); return v.progress && v.progress.phase === 'editing' ? v : null; }, 10000);
  assert.equal(v1.status, 'running'); assert.equal(v1.reset, false);
  const again = jr.view(id, v1.offset, v1.progress.seq);
  assert.equal(again.progress, null);                            // unchanged -> not re-sent
  assert.notEqual(jr.view(0, 0, v1.progress.seq).progress, null); // other job id -> pseq ignored, full send + reset
  assert.equal(jr.view(0, 0, 5).reset, true);
  const done = await until(() => { const v = jr.view(id, 0, -1); return v.status === 'done' ? v : null; }, 10000);
  assert.equal(done.progress.phase, 'done');
});

test('progress:false does not pass --progress-file', async () => {
  const runBrief = makeMockRunBrief();
  const jr = new JobRunner({ cwd: process.cwd(), progress: false, runBrief });
  const { id } = jr.start({});
  const v = await until(() => { const x = jr.view(id, 0, -1); return x.status === 'done' ? x : null; }, 10000);
  assert.equal(v.progress, null);
});

test('non-zero exit -> failed', async () => {
  const runBrief = makeMockRunBrief({ fail: true });
  const jr = new JobRunner({ cwd: process.cwd(), runBrief });
  const { id } = jr.start({});
  const v = await until(() => { const x = jr.view(id, 0, -1); return x.status === 'failed' ? x : null; }, 10000);
  assert.equal(v.exitCode, 3);
});
