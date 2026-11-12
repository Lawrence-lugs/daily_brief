// E2E repro for "Generation error: lost contact with the server" on the hosted version.
//
// The browser polls GET /api/job every ~700ms while a generation runs. If the job's CPU-bound
// work (the LR ranker fit, embeddings, ...) runs on the HTTP server's own event loop, /api/job
// cannot answer during that work. The hosted reverse proxy then times out or returns a non-JSON
// error, the client counts consecutive failures and gives up with "lost contact with the server".
//
// This test runs a real HTTP server serving /api/job from a real JobRunner, starts a job whose
// work is CPU-bound, and polls exactly like client.js. Every poll must answer quickly.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobRunner, forkRunBrief } from '../lib/jobs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CPU_BRIEF_CHILD = path.join(here, 'fixtures', 'cpu_brief_child.js');

function startServer(jr) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/api/job') { res.writeHead(404); return res.end(); }
    const v = jr.view(Number(u.searchParams.get('id')), u.searchParams.get('since'), u.searchParams.get('pseq'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('job polls stay responsive while the brief does CPU-bound work', async () => {
  const jr = new JobRunner({ cwd: here, runBrief: forkRunBrief(CPU_BRIEF_CHILD) });
  const server = await startServer(jr);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { id } = jr.start({ engine: 'lr' });
    let worst = 0, polls = 0, j;
    let offset = 0, pseq = -1;
    do {
      const t = Date.now();
      j = await (await fetch(`${base}/api/job?id=${id}&since=${offset}&pseq=${pseq}`)).json();
      worst = Math.max(worst, Date.now() - t);
      polls++;
      offset = j.offset;
      if (j.status === 'running') await sleep(700);
    } while (j.status === 'running');
    assert.equal(j.status, 'done');
    assert.ok(worst < 1000, `slowest /api/job poll took ${worst}ms over ${polls} polls (the browser gives up after ~20 failures)`);
  } finally {
    server.close();
  }
});
