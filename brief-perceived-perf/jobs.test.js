import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobRunner } from '../lib/jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake "python": a node script that honours --log-file / --progress-file like brief.py does.
function fakeScript() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fakebrief-'));
  const file = path.join(dir, 'fake.mjs');
  writeFileSync(file, `
    import { writeFileSync, renameSync } from 'node:fs';
    const a = process.argv.slice(2), i = (k) => a.indexOf(k), arg = (k) => (i(k) >= 0 ? a[i(k) + 1] : undefined);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let seq = 0;
    const prog = (phase, desks = {}) => { const f = arg('--progress-file'); if (typeof f !== 'string' || !f.endsWith('progress.json')) return;
      writeFileSync(f + '.tmp', JSON.stringify({ v: 1, seq: ++seq, phase, engine: 'lr', t0: 1, desks })); renameSync(f + '.tmp', f); };
    writeFileSync(arg('--log-file'), 'start\\n');
    prog('selecting'); await wait(700);
    prog('editing', { primary: { title: 'P', n: 1, stage: 'raw', working: true, deck: '', items: [] } }); await wait(700);
    prog('done');
    if (process.env.FAKE_FAIL) process.exit(3);
  `);
  return file;
}

async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(60); } throw new Error('timeout'); }

test('progress is exposed, only re-sent when seq changed, and job completes', async () => {
  const jr = new JobRunner({ python: process.execPath, script: fakeScript(), cwd: process.cwd() });
  const { id } = jr.start({ engine: 'lr' });
  const v1 = await until(() => { const v = jr.view(id, 0, -1); return v.progress && v.progress.phase === 'editing' ? v : null; });
  assert.equal(v1.status, 'running'); assert.equal(v1.reset, false);
  const again = jr.view(id, v1.offset, v1.progress.seq);
  assert.equal(again.progress, null);                            // unchanged -> not re-sent
  assert.notEqual(jr.view(0, 0, v1.progress.seq).progress, null); // other job id -> pseq ignored, full send + reset
  assert.equal(jr.view(0, 0, 5).reset, true);
  const done = await until(() => { const v = jr.view(id, 0, -1); return v.status === 'done' ? v : null; });
  assert.equal(done.progress.phase, 'done');
});

test('progress:false does not pass --progress-file', async () => {
  const jr = new JobRunner({ python: process.execPath, script: fakeScript(), cwd: process.cwd(), progress: false });
  const { id } = jr.start({});
  const v = await until(() => { const x = jr.view(id, 0, -1); return x.status === 'done' ? x : null; });
  assert.equal(v.progress, null);
});

test('non-zero exit -> failed', async () => {
  process.env.FAKE_FAIL = '1';
  const jr = new JobRunner({ python: process.execPath, script: fakeScript(), cwd: process.cwd() });
  const { id } = jr.start({});
  const v = await until(() => { const x = jr.view(id, 0, -1); return x.status === 'failed' ? x : null; });
  assert.equal(v.exitCode, 3);
  delete process.env.FAKE_FAIL;
});
