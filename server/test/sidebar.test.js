// jsdom smoke test for the sidebar: real page.html template, real sidebar.js. (devDependency: jsdom)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SIDEBAR = read('../public/sidebar.js');
// Same {{name}} substitution contract as render.js fill(); unknown placeholders fail the test.
const KNOWN = new Set(['css', 'paper_name', 'date_long', 'boot', 'brief_options', 'status', 'status_class', 'generate_label',
  'edition', 'generated', 'primary_title', 'primary_deck', 'primary_stories', 'science_title', 'science_deck', 'science_stories', 'footer', 'basePath', 'hosted', 'gen_hidden',
  'desk_grid_style', 'desk_sections', 'repo_url', 'commit_html']);
const p2 = (n) => String(n).padStart(2, '0');
const day = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const OPTIONS = `<option value="3" selected>${day(0)} 09:10 [lr]</option><option value="2">${day(0)} 07:00 [keyword]</option><option value="1">${day(1)} 18:30</option>`;

function page(extra = {}) {
  const deskSec = `<section data-swap="desk-primary" class="md:pr-6"><h2 class="x">Primary</h2><p class="x" data-desk-deck="primary"></p><div data-desk-stories="primary"></div></section><section data-swap="desk-science" class="md:pl-6"><h2 class="x">Science</h2><p class="x" data-desk-deck="science"></p><div data-desk-stories="science"></div></section>`;
  const vals = { css: '', paper_name: 'The Daily Die', date_long: 'x', boot: '{"stories":{}}', brief_options: OPTIONS, status: 'Brief for today',
    status_class: '', generate_label: 'Regenerate', desk_grid_style: '', desk_sections: deskSec, ...extra };
  const html = read('../templates/page.html').replace(/\{\{(\w+)\}\}/g, (_, k) => { assert.ok(KNOWN.has(k), 'unknown placeholder ' + k); return vals[k] ?? ''; });
  const dom = new JSDOM(html, { url: 'http://localhost/?theme=light', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.document.documentElement.dataset.sb = 'expanded';
  dom.window.eval(SIDEBAR);
  return dom.window;
}
const key = (w, el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

test('template keeps every id client.js and the fixtures depend on', () => {
  const d = page().document;
  for (const id of ['brief-select', 'status', 'engine-select', 'btn-generate', 'btn-archive', 'btn-theme', 'btn-logs', 'log-popup', 'gen-panel', 'boot'])
    assert.ok(d.getElementById(id), '#' + id);
  assert.equal(d.querySelectorAll('[data-swap]').length, 4);
  assert.ok(![...d.querySelectorAll('[data-swap]')].some((el) => el.closest('#sidebar')), 'sidebar must be outside [data-swap]');
});

test('brief picker: label, grouped flyout, keyboard pick fires change on the real select', () => {
  const w = page(), d = w.document, sel = d.getElementById('brief-select');
  assert.match(d.getElementById('sb-brief-label').textContent, /09:10 \[lr\]/);
  assert.equal(d.getElementById('sb-next').disabled, true);    // newest already selected
  assert.equal(d.getElementById('sb-prev').disabled, false);
  let changed = 0; d.addEventListener('change', (e) => { if (e.target.id === 'brief-select') changed++; });
  d.getElementById('sb-brief').click();
  const pop = d.getElementById('sb-pop');
  assert.equal(pop.hidden, false);
  assert.deepEqual([...pop.querySelectorAll('.sb-pop-day')].map((n) => n.textContent.slice(0, 9)), ['Today', 'Yesterday']);
  assert.equal(d.activeElement.dataset.value, '3');             // focus starts on the selected option
  key(w, pop, 'ArrowDown');
  assert.equal(d.activeElement.dataset.value, '2');
  key(w, pop, 'Enter');
  assert.equal(sel.value, '2'); assert.equal(changed, 1); assert.equal(pop.hidden, true);
});

test('stepper goes to the older brief; select innerHTML rewrite (swapToLatest) re-syncs the label', async () => {
  const w = page(), d = w.document, sel = d.getElementById('brief-select');
  d.getElementById('sb-prev').click();
  assert.equal(sel.value, '2');
  sel.innerHTML = `<option value="9" selected>${day(0)} 12:00 [lr]</option>`;
  await new Promise((r) => setTimeout(r, 20));
  assert.match(d.getElementById('sb-brief-label').textContent, /12:00 \[lr\]/);
  assert.equal(d.getElementById('sb-prev').disabled, true);
});

test('engine segmented control drives #engine-select and mirrors disabled', async () => {
  const w = page(), d = w.document, sel = d.getElementById('engine-select');
  const btns = [...d.querySelectorAll('#sb-engine-seg button')];
  assert.equal(btns.length, 3);
  btns[1].click();
  assert.equal(sel.value, 'lr'); assert.equal(btns[1].getAttribute('aria-pressed'), 'true');
  sel.disabled = true;                                           // what runFlow() does while generating
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(btns.every((b) => b.disabled));
});

test('status dot follows classes and busy state; errors toast only when collapsed', async () => {
  const w = page(), d = w.document, st = d.getElementById('status'), dot = d.getElementById('sb-dot'), toast = d.getElementById('sb-toast');
  const tick = () => new Promise((r) => setTimeout(r, 20));
  st.classList.add('error'); st.textContent = 'Generation failed: boom'; await tick();
  assert.equal(dot.dataset.state, 'error'); assert.equal(toast.hidden, true);   // expanded: text already visible
  st.classList.remove('error'); await tick();
  d.getElementById('btn-generate').disabled = true; await tick();
  assert.equal(dot.dataset.state, 'busy');
  d.getElementById('btn-generate').disabled = false;
  d.getElementById('sb-toggle').click();                          // collapse
  assert.equal(d.documentElement.dataset.sb, 'collapsed');
  assert.equal(w.localStorage.getItem('db-sidebar'), 'collapsed');
  st.classList.add('error'); await tick();
  assert.equal(toast.hidden, false); assert.match(toast.textContent, /boom/);
});

test('generate icon follows the label; archive-style ids untouched', () => {
  assert.equal(page().document.getElementById('sb-gen-icon').className, 'bi bi-arrow-clockwise');
  assert.equal(page({ generate_label: 'Generate brief' }).document.getElementById('sb-gen-icon').className, 'bi bi-stars');
});
