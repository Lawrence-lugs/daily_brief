// Run: npm test   (needs Node >= 22.13; no python required)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../app.js';
import { esc, ageLabel } from '../lib/render.js';

const real = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'brief-test-'));
copyFileSync(path.join(real, 'schema.sql'), path.join(root, 'schema.sql'));
cpSync(path.join(real, 'server'), path.join(root, 'server'), { recursive: true });
writeFileSync(path.join(root, 'tailwind.css'), '/* css */');
writeFileSync(path.join(root, 'config.json'), JSON.stringify({ paper_name: 'TEST', db_file: 'test.db' }));

// seed
const seed = new DatabaseSync(path.join(root, 'test.db'));
seed.exec(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
const today = (() => { const n = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`; })();
seed.prepare(`INSERT INTO briefs (date,edition,generated_at,model,desks,meta) VALUES (?,?,?,?,?,?)`).run(
  today, 1, new Date().toISOString(), 'm',
  JSON.stringify({ primary: { title: 'Silicon <b>', deck: 'deck' }, science: { title: 'Science', deck: 'd2' } }),
  JSON.stringify({ model: 'm', n_fresh: 1, n_archive: 0, n_explore: 0, epsilon: 0.25, pool: 5, sources: 'x' }));
const ins = seed.prepare(`INSERT INTO stories (brief_id,item_id,desk,position,headline,blurb,url,source,subtopic,age_days,tags,kind)
  VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`);
ins.run('aaa', 'primary', 0, 'Lead <script>x</script>', 'blurb', 'https://e.com/a', 'S', 'sub', 0.5, '["t1"]', 'fresh');
ins.run('bbb', 'primary', 1, 'Second', 'blurb', 'javascript:alert(1)', 'S', 'sub', 3, '[]', 'archive');
ins.run('ccc', 'science', 0, 'Sci', 'blurb', 'https://e.com/c', 'S', 'sub', 20, '[]', 'fresh');
seed.exec(`UPDATE stories SET score_p=0.731, score_v=0.2, cos_dist=0.1234, cluster_size=7, cluster_pool=19, medoid_id='ps:x' WHERE story_id=1`);
seed.close();

const PORT = 45873;
const PORT2 = 45874;
let shutdownCalled = false;
const app = createApp({ root, port: PORT, onShutdown: () => { shutdownCalled = true; } });
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
// Prefixed app: BRIEF_BASE_PATH equivalent via the createApp option.
const app2 = createApp({ root, port: PORT2, basePath: '/dailydie' });
const server2 = http.createServer(app2.handler);
await new Promise((r) => server2.listen(PORT2, '127.0.0.1', r));
test.after(() => { server.close(); app.close(); server2.close(); app2.close(); });

const call = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...headers } }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const call2 = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT2, path: p, method, headers: { ...headers } }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const W = { 'X-Brief-Client': '1', 'Content-Type': 'application/json' };

test('helpers', () => {
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;');
  assert.equal(ageLabel(0.5), 'today'); assert.equal(ageLabel(20), '2 weeks ago'); assert.equal(ageLabel(90), '3 months ago');
});
test('page renders escaped content, safe urls, boot state', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('Lead &lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!r.body.includes('<script>x'));
  assert.ok(r.body.includes('Silicon &lt;b&gt;'));
  assert.ok(!r.body.includes('javascript:alert'));
  assert.ok(r.body.includes('data-story-id="1"'));
  assert.ok(r.body.includes('From the archive'));
});
test('guard: bad host, missing header, bad origin', async () => {
  assert.equal((await call('GET', '/', { headers: { Host: 'evil.com' } })).status, 403);
  assert.equal((await call('POST', '/api/stories/1/feedback', { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await call('POST', '/api/stories/1/feedback', { headers: { ...W, Origin: 'http://evil.com' }, body: '{}' })).status, 403);
});
test('feedback persists and shows up in page + training export', async () => {
  let r = await call('POST', '/api/stories/1/feedback', { headers: W, body: JSON.stringify({ action: 'like', value: true }) });
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { item_id: 'aaa', liked: 1, saved: 0 });
  r = await call('POST', '/api/stories/1/feedback', { headers: W, body: JSON.stringify({ action: 'save', value: true }) });
  assert.deepEqual(JSON.parse(r.body), { item_id: 'aaa', liked: 1, saved: 1 });
  assert.ok((await call('GET', '/')).body.includes('"1":{"liked":true,"saved":true}'));
  const lines = (await call('GET', '/api/export/training.jsonl')).body.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3); assert.equal(lines[0].y_like, 1); assert.equal(lines[1].y_like, 0);
  r = await call('POST', '/api/stories/1/feedback', { headers: W, body: JSON.stringify({ action: 'like', value: false }) });
  assert.equal(JSON.parse(r.body).liked, 0);
});
test('feedback validation / 404', async () => {
  assert.equal((await call('POST', '/api/stories/1/feedback', { headers: W, body: '{"action":"x","value":true}' })).status, 400);
  assert.equal((await call('POST', '/api/stories/999/feedback', { headers: W, body: '{"action":"like","value":true}' })).status, 404);
  assert.equal((await call('GET', '/brief/999')).status, 404);
});
test('static traversal blocked, health ok, job idle', async () => {
  assert.equal((await call('GET', '/static/../../config.json')).status === 200, false);
  assert.equal(JSON.parse((await call('GET', '/api/health')).body).name, 'daily-brief');
  assert.equal(JSON.parse((await call('GET', '/api/job?id=0&since=0')).body).status, 'idle');
});

test('shutdown endpoint: missing client header is refused, valid request shuts down', async () => {
  // No X-Brief-Client header -> guard refuses the write.
  assert.equal((await call('POST', '/api/shutdown', { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  // Valid client request -> 200 and triggers the clean shutdown callback.
  shutdownCalled = false;
  const r = await call('POST', '/api/shutdown', { headers: W, body: '{}' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.ok(shutdownCalled);
});

test('backside renders the snapshot (and dashes for stories without one)', async () => {
  const b = (await call('GET', '/')).body;
  assert.ok(b.includes('0.731') && b.includes('0.123') && b.includes('19 candidates'));
  assert.ok(b.includes('ps:x'));                       // no perfect_samples.json in the temp root -> id fallback
  assert.ok(b.includes('No ranker data for this card'));   // stories 2 and 3 have no snapshot
});

test('prefix: bare base path redirects to base path with trailing slash', async () => {
  const r = await call2('GET', '/dailydie');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/dailydie/');
});

test('prefix: base path serves the brief page', async () => {
  const r = await call2('GET', '/dailydie/');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('Lead &lt;script&gt;x&lt;/script&gt;'));
  assert.ok(r.body.includes('<base href="/dailydie/">'));
  assert.ok(r.body.includes('data-base="/dailydie"'));
});

test('prefix: API routes work under the base path', async () => {
  const r = await call2('GET', '/dailydie/api/health');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).name, 'daily-brief');
  const r2 = await call2('GET', '/dailydie/brief/999');
  assert.equal(r2.status, 404);
});

test('prefix: requests outside the prefix 404', async () => {
  assert.equal((await call2('GET', '/')).status, 404);
  assert.equal((await call2('GET', '/api/health')).status, 404);
  assert.equal((await call2('GET', '/foo')).status, 404);
});

test('prefix: shutdown endpoint is not exposed when hosted', async () => {
  const r = await call2('POST', '/dailydie/api/shutdown', { headers: { 'X-Brief-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 404);
});

test('hosted: restricted generate reachable; raw generate + shutdown blocked; likes/saves enabled', async () => {
  const restricted = await call2('POST', '/dailydie/api/restricted/generate', { headers: { 'X-Brief-Client': '1', 'Content-Type': 'application/json' }, body: '{"engine":"lr"}' });
  assert.ok([202, 409].includes(restricted.status), `restricted/generate expected 202/409, got ${restricted.status}`);

  const raw = await call2('POST', '/dailydie/api/generate', { headers: { 'X-Brief-Client': '1', 'Content-Type': 'application/json' }, body: '{"engine":"lr"}' });
  assert.equal(raw.status, 404, 'raw /api/generate must be 404 on hosted path');

  const sdown = await call2('POST', '/dailydie/api/shutdown', { headers: { 'X-Brief-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(sdown.status, 404, 'shutdown must stay blocked on hosted path');

  const fb = await call2('POST', '/dailydie/api/stories/1/feedback', { headers: { 'X-Brief-Client': '1', 'Content-Type': 'application/json', 'X-Session-Id': 's1' }, body: '{"action":"like","value":true}' });
  assert.ok(!fb.body.includes('"not found"'), 'feedback reaches the handler, not the hosted guard');

  const page = await call2('GET', '/dailydie/');
  assert.ok(!page.body.includes('style="display:none"'), 'generate UI must be visible on hosted path');
});

test('local: generate UI visible and not hosted', async () => {
  const page = await call('GET', '/');
  assert.ok(!page.body.includes('style="display:none"'), 'generate UI must be visible locally');
});

test('prefix: without a base path set, behaviour is unchanged', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/dailydie/')).status, 404);
  assert.equal((await call('GET', '/')).status, 200);
});
