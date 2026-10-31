// Archive / list view: search + filters (external toolbar) -> /api/stories -> Grid.js (render + server-side paging).
// Design: Grid.js owns ONLY table rendering and pagination. Every filter lives in `state`; any change re-creates
// the grid (so paging always restarts at page 1 and a stale response can never overwrite a newer one).
(() => {
  const $ = (id) => document.getElementById(id);
  const sp0 = new URLSearchParams(location.search);
  const embed = sp0.get('embed') === '1';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": "&#39;"
  }[c]));
  // Server marks FTS hits with \x01 ... \x02 (see highlight() in search.js). Escape FIRST, then swap markers for <mark>.
  const hl = (marked, plain) => esc(marked ?? plain).replace(/\x01/g, '<mark>').replace(/\x02/g, '</mark>');
  const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // ---- theme (same contract as client.js: ?theme= wins, parent window may push updates, else follow the OS)
  const setTheme = (t) => { const c = document.documentElement.classList; c.remove('dark', 'light'); c.add(t === 'dark' ? 'dark' : 'light'); };
  setTheme(sp0.get('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  addEventListener('message', (e) => { if (e.source === window.parent && e.data && e.data.type === 'theme') setTheme(e.data.theme); });

  // ---- filter state <-> URL (so a filtered view is bookmarkable and survives reload)
  const KEYS = ['q', 'mark', 'desk', 'subtopic', 'source', 'from', 'to', 'sort'];
  const state = Object.fromEntries(KEYS.map((k) => [k, sp0.get(k) ?? '']));
  state.tags = sp0.getAll('tag');
  function persist() {
    const p = new URLSearchParams(location.search); // keeps embed= / theme=
    for (const k of KEYS) state[k] ? p.set(k, state[k]) : p.delete(k);
    p.delete('tag'); state.tags.forEach((t) => p.append('tag', t));
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }
  function apiUrl() {
    const p = new URLSearchParams();
    for (const k of KEYS) if (state[k]) p.set(k, state[k]);
    state.tags.forEach((t) => p.append('tag', t));
    const qs = p.toString();
    return '/api/stories?' + qs; // always include ? so Grid.js can append with &
  }

  // ---- cell renderers (all text goes through esc()/hl())
  const storyHtml = (r) => `
    <div class="story-cell">
      <div class="story-meta">${esc(r.desk)} &middot; ${esc(r.source)} &middot; ${esc(r.subtopic)}</div>
      <a class="story-head" href="${esc(r.url)}">${hl(r.h_headline, r.headline)}</a>
      <p class="story-blurb">${hl(r.h_blurb, r.blurb)}</p>
      ${r.tags.length ? `<div class="story-tags">${r.tags.map((t) => `<span>#${esc(t)}</span>`).join(' ')}</div>` : ''}
    </div>`;
  const actionsHtml = (r) => `
    <div class="story-actions">
      <button type="button" class="btn-save" aria-pressed="${r.saved}" data-action="save" data-story-id="${r.story_id}" title="Save story">
        <span class="save-mark" aria-hidden="true"></span><span class="sr-only">Save story</span></button>
      <button type="button" class="btn-like" aria-pressed="${r.liked}" data-action="like" data-story-id="${r.story_id}" title="Like story">
        <span class="like-mark" aria-hidden="true"></span><span class="sr-only">Like story</span></button>
    </div>`;

  // ---- grid
  const host = $('grid'), countEl = $('count');
  let grid = null, gen = 0;
  function render() {
    const mine = ++gen;
    persist();
    if (grid) { try { grid.destroy(); } catch { /* already gone */ } grid = null; }
    host.innerHTML = '';
    grid = new gridjs.Grid({
      columns: [
        { name: 'Date', width: '120px', formatter: (d) => fmtDate(d) },
        { name: 'Story', formatter: (r) => gridjs.html(storyHtml(r)) },
        { name: 'Mark', width: '90px', formatter: (r) => gridjs.html(actionsHtml(r)) },
      ],
      autoWidth: false,
      width: '100%',
      sort: false,
      search: false, // our own #q input drives the query
      className: { container: 'newspaper-grid' },
      language: {
        loading: 'Setting type\u2026',
        noRecordsFound: 'No stories match these filters.',
        error: 'Could not load stories.',
        pagination: { previous: '\u2039', next: '\u203A', showing: 'Showing', results: () => 'stories' },
      },
      pagination: { limit: 25, server: { url: (prev, page, limit) => `${prev}&limit=${limit}&offset=${page * limit}` } },
      server: {
        url: apiUrl(),
        then: (d) => {
          if (mine === gen) countEl.textContent = `${d.total} ${d.total === 1 ? 'story' : 'stories'}`;
          return d.rows.map((r) => [r.date, r, r]); // object cells are fine: formatters receive them as-is
        },
        total: (d) => d.total,
      },
    }).render(host);
  }

  // ---- like / save (same endpoint + guard header as client.js; optimistic with revert)
  async function toggle(btn) {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    try {
      const r = await fetch(`/api/stories/${btn.dataset.storyId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Brief-Client': '1' },
        body: JSON.stringify({ action: btn.dataset.action, value: on }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch { btn.setAttribute('aria-pressed', String(!on)); }
  }
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) { e.preventDefault(); toggle(btn); return; }
    const a = e.target.closest('a[href]');
    if (a && /^https?:/i.test(a.href) && !a.href.startsWith(location.origin)) {
      if (embed) { e.preventDefault(); parent.postMessage({ type: 'open-url', url: a.href }, '*'); }
      else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
  });

  // ---- toolbar wiring
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const qEl = $('q');
  qEl.value = state.q;
  qEl.addEventListener('input', debounce(() => { state.q = qEl.value; render(); }, 250));
  $('filters').addEventListener('submit', (e) => e.preventDefault());

  const markBtns = [...document.querySelectorAll('#mark [data-mark]')];
  const syncMark = () => markBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mark === state.mark)));
  markBtns.forEach((b) => b.addEventListener('click', () => { state.mark = b.dataset.mark; syncMark(); render(); }));
  syncMark();

  for (const k of ['desk', 'subtopic', 'source', 'from', 'to', 'sort']) {
    $(k).addEventListener('change', (e) => { state[k] = e.target.value; render(); });
    $(k).value = state[k];
  }
  $('reset').addEventListener('click', () => {
    KEYS.forEach((k) => { state[k] = ''; if ($(k)) $(k).value = ''; });
    state.tags = []; qEl.value = ''; syncMark(); drawTags(); render();
  });

  // ---- facets: fill selects + tag chips (best effort; the list works without them)
  let tagFacet = [];
  function drawTags() {
    const all = [...new Set([...tagFacet.map((t) => t.value), ...state.tags])];
    const n = new Map(tagFacet.map((t) => [t.value, t.n]));
    $('tagbar').innerHTML = all.map((t) =>
      `<button type="button" class="chip" aria-pressed="${state.tags.includes(t)}" data-tag="${esc(t)}">#${esc(t)}${n.has(t) ? ` <small>${n.get(t)}</small>` : ''}</button>`).join('');
  }
  $('tagbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]'); if (!b) return;
    const t = b.dataset.tag;
    state.tags = state.tags.includes(t) ? state.tags.filter((x) => x !== t) : [...state.tags, t].slice(0, 5);
    drawTags(); render();
  });
  fetch('/api/stories/facets').then((r) => r.json()).then((f) => {
    for (const k of ['desk', 'subtopic', 'source']) {
      const sel = $(k);
      const vals = f[k].map((x) => x.value);
      if (state[k] && !vals.includes(state[k])) vals.push(state[k]);
      const count = new Map(f[k].map((x) => [x.value, x.n]));
      sel.insertAdjacentHTML('beforeend', vals.map((v) => `<option value="${esc(v)}">${esc(v)}${count.has(v) ? ` (${count.get(v)})` : ''}</option>`).join(''));
      sel.value = state[k];
    }
    tagFacet = f.tag; drawTags();
  }).catch(() => drawTags());

  render();
})();