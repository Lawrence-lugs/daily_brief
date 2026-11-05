// Smoke test of the whole client flow in jsdom (devDependency: `npm i -D jsdom`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import '../public/genmodel.js';

const CLIENT = readFileSync(new URL('../public/client.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = (boot, body) => `<!doctype html><html><head><title>Brief</title></head><body>
<script id="boot" type="application/json">${JSON.stringify(boot)}</script>
<div id="status" class="">${body.status}</div><pre id="log-popup" hidden></pre>
<button id="btn-logs"></button><button id="btn-archive"></button>
<select id="brief-select">${body.options}</select>
<select id="engine-select"><option value="lr">lr</option></select><button id="btn-generate"></button>
<section id="gen-panel" hidden></section>
<div data-swap="desk-primary"><p data-desk-deck="primary">${body.deck}</p><div data-desk-stories="primary">${body.primary}</div></div>
<div data-swap="desk-science"><p data-desk-deck="science"></p><div data-desk-stories="science">${body.science}</div></div>
</body></html>`;

const card = (id, t) => `<article class="story-card" data-story-id="${id}"><button data-action="like" data-story-id="${id}"></button>${t}</article>`;

test('generate: skeleton/dim -> raw preview -> edited desk -> in-place swap, previews are inert', async () => {
  const initial = PAGE({ briefId: 1, date: '2026-11-04', embed: false, stories: { 1: { liked: true, saved: false } } },
    { status: 'Brief for 2026-11-04', options: '<option value="1">old</option>', deck: 'old deck', primary: card(1, 'OLD'), science: '' });
  const final = PAGE({ briefId: 7, date: '2026-11-05', embed: false, stories: { 7: { liked: true, saved: false } } },
    { status: 'Brief for 2026-11-05', options: '<option value="7">new</option>', deck: 'Final deck', primary: card(7, 'FINAL'), science: card(8, 'FINAL-SCI') });

  const dom = new JSDOM(initial, { url: 'http://localhost/?theme=light', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const calls = []; let jobCalls = 0; const snaps = {};
  const pv = (seq, phase, p, s) => ({ seq, phase, engine: 'lr', t0: Date.now() / 1000, desks: { primary: p, science: s } });
  const pend = { stage: 'pending', working: false, n: 5, deck: '', html: '', title: 'P' };

  w.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => '' });
    if (url.startsWith('/api/generate')) return json({ id: 1 }, 202);
    if (url.startsWith('/api/job')) {
      if (jobCalls === 0 && url.includes('id=0') && !calls.some((c) => c.includes('generate'))) return json({ status: 'idle' });
      jobCalls++;
      const k = jobCalls;
      snaps[k] = { primary: d.querySelector('[data-desk-stories="primary"]').className, science: d.querySelector('[data-desk-stories="science"]').className,
        skel: d.querySelectorAll('.gen-skel').length, primaryHtml: d.querySelector('[data-desk-stories="primary"]').innerHTML };
      if (k === 1) return json({ id: 1, status: 'running', reset: true, log: 'a\n', offset: 2, preview: pv(1, 'selecting', pend, pend) });
      if (k === 2) return json({ id: 1, status: 'running', reset: false, log: '', offset: 2, preview: pv(2, 'editing',
        { ...pend, stage: 'raw', working: true, html: '<article class="story-card" data-story-id=""><button data-action="like" data-story-id=""></button>RAW1</article>' },
        { ...pend, stage: 'raw', html: '<article class="story-card">RAWS</article>' }) });
      if (k === 3) {
        // user taps like on a preview card: must NOT hit the feedback endpoint
        d.querySelector('[data-desk-stories="primary"] [data-action]')?.click();
        return json({ id: 1, status: 'running', reset: false, log: '', offset: 2, preview: pv(3, 'editing',
          { ...pend, stage: 'edited', deck: 'New deck', html: '<article class="story-card">EDITED1</article>' },
          { ...pend, stage: 'raw', working: true, html: '<article class="story-card">RAWS</article>' }) });
      }
      return json({ id: 1, status: 'done', reset: false, log: '', offset: 2, preview: null });
    }
    if (url.startsWith('/') && !opts.method) return { ok: true, status: 200, text: async () => final };
    throw new Error('unexpected fetch ' + url);
  };
  w.GenModel = globalThis.GenModel;
  w.eval(CLIENT);
  await sleep(50);
  d.getElementById('btn-generate').click();
  assert.equal(d.getElementById('btn-generate').disabled, true);
  await until(() => jobCalls >= 4 && !d.getElementById('btn-generate').disabled && d.querySelector('[data-desk-stories="primary"]').innerHTML.includes('FINAL'), 12000);

  // after poll 1 (applied before poll 2): old edition dimmed, empty desk gets skeletons
  assert.match(snaps[2].primary, /is-dim/);
  assert.match(snaps[2].science, /is-skeleton/); assert.equal(snaps[2].skel, 5);
  // raw winners shown, marked as preview
  assert.match(snaps[3].primary, /is-preview/); assert.ok(snaps[3].primaryHtml.includes('RAW1'));
  // edited desk revealed before the job finished
  assert.ok(snaps[4].primaryHtml.includes('EDITED1'));
  assert.equal(d.querySelector('[data-desk-deck="primary"]').textContent, 'Final deck');
  // inert like on preview
  assert.ok(!calls.some((c) => c.includes('/feedback')), 'preview like/save must not call the server');
  // final state: swapped in place, boot state replaced, no navigation
  assert.ok(d.querySelector('[data-desk-stories="science"]').innerHTML.includes('FINAL-SCI'));
  // the in-memory like/save state was replaced: the NEW card's button reflects it (old id 1 is gone)
  assert.equal(d.querySelector('[data-desk-stories="primary"] [data-action][data-story-id="7"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.getElementById('status').textContent, 'Brief for 2026-11-05');
  assert.equal(d.getElementById('brief-select').innerHTML, '<option value="7">new</option>');
  assert.equal(d.getElementById('gen-panel').hidden, true);
  assert.equal(w.location.pathname, '/');
  assert.ok(calls.filter((c) => c.startsWith('GET /api/job')).every((c) => c.includes('pseq=')));
  w.close();
});

async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await sleep(50); } throw new Error('timeout'); }
