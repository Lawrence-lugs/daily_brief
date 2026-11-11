// Client for the daily-brief page: like/save persistence, Generate + live progress, theme, embed bridge.
// Generation flow (perceived-performance design):
//   POST /api/generate -> poll /api/job (log + `preview`) -> render preview cards in place as they
//   appear (LR: raw winners right after selection; both engines: each desk as soon as it is edited)
//   -> on done, fetch the finished page and swap [data-swap] regions in place (no full reload).
// Requires (see PLAN.md): #gen-panel, [data-swap] regions, [data-desk-stories]/[data-desk-deck] per desk,
// and /static/genmodel.js loaded before this file. Everything degrades to "reload at the end" if missing.
(() => {
  const boot = JSON.parse(document.getElementById('boot').textContent);
  const stories = boot.stories;          // mutated in place after an in-place swap
  const $ = (id) => document.getElementById(id);
  const base = document.body.dataset.base || '';
  const u = (p) => base + p;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- session id: client-generated UUID stored in localStorage, sent as X-Session-Id header
  const SESSION_KEY = 'db-session-id';
  function genSessionId() {
    return crypto.randomUUID();
  }
  let sessionId = null;
  try {
    sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = genSessionId();
      localStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch { sessionId = genSessionId(); }
  // Mirror into a cookie so the server can render this session's like/save marks on plain page loads.
  try { document.cookie = `${SESSION_KEY}=${sessionId}; Path=/; Max-Age=31536000; SameSite=Lax`; } catch {}

  const post = (url, body, extraHeaders = {}) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Brief-Client': '1', 'X-Session-Id': sessionId, ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });

  // ---- theme: ?theme=dark|light wins, then an explicit saved choice, else follow the OS
  const THEME_KEY = 'db-theme';
  const setTheme = (t) => {
    const c = document.documentElement.classList;
    c.remove('dark', 'light'); c.add(t === 'dark' ? 'dark' : 'light');
    const tb = $('btn-theme');
    if (tb) { tb.setAttribute('aria-pressed', String(t === 'dark')); tb.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; }
  };
  const savedTheme = () => {
    try { const v = localStorage.getItem(THEME_KEY); return v === 'dark' || v === 'light' ? v : null; }
    catch { return null; }
  };
  const qTheme = new URLSearchParams(location.search).get('theme');
  setTheme(qTheme ?? savedTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  addEventListener('message', (e) => {
    if (e.source === window.parent && e.data && e.data.type === 'theme') setTheme(e.data.theme);
  });
  const tb = $('btn-theme');
  if (tb) tb.onclick = () => {
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    const p = new URLSearchParams(location.search);
    p.set('theme', next);
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : ''));
  };

  // ---- like / save
  function applyState() {
    document.querySelectorAll('[data-action]').forEach((btn) => {
      const s = stories[btn.dataset.storyId] || {};
      btn.setAttribute('aria-pressed', String(btn.dataset.action === 'save' ? !!s.saved : !!s.liked));
    });
  }
  async function toggle(btn) {
    const id = btn.dataset.storyId, action = btn.dataset.action;
    const key = action === 'save' ? 'saved' : 'liked';
    const s = stories[id] || (stories[id] = { liked: false, saved: false });
    const next = !s[key];
    s[key] = next; applyState();                       // optimistic
    try {
      const r = await post(u(`/api/stories/${id}/feedback`), { action, value: next });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      s.liked = !!j.liked; s.saved = !!j.saved;
    } catch (err) {
      s[key] = !next;                                  // revert
      setStatus('Could not save: ' + err.message, true);
    }
    applyState();
  }

  // ---- card flip. The hidden face is made `inert` so its links/buttons can't be tabbed to or clicked.
  function setFlipped(card, on) {
    card.classList.toggle('is-flipped', on);
    const front = card.querySelector('.story-front'), back = card.querySelector('.story-back');
    front.inert = on; back.inert = !on;
    front.setAttribute('aria-hidden', String(on)); back.setAttribute('aria-hidden', String(!on));
    front.querySelector('[data-flip]')?.setAttribute('aria-expanded', String(on));
    (on ? back : front).querySelector('[data-flip]')?.focus({ preventScroll: true });
  }

  document.addEventListener('click', (e) => {
    // Preview cards are not in the DB yet (no story id): like/save/flip do nothing until the swap.
    if (e.target.closest('.is-preview') && e.target.closest('[data-flip],[data-action]')) { e.preventDefault(); return; }
    const flip = e.target.closest('[data-flip]');     // NOT data-action: that is the like/save toggle
    if (flip) {
      e.preventDefault();
      const card = flip.closest('.story-card');
      if (card) setFlipped(card, !card.classList.contains('is-flipped'));
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (btn) { e.preventDefault(); toggle(btn); return; }
    const a = e.target.closest('a[href]');
    if (a && /^https?:/i.test(a.href) && !a.href.startsWith(location.origin)) {
      if (boot.embed) { e.preventDefault(); parent.postMessage({ type: 'open-url', url: a.href }, '*'); }
      else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
  });

  // ---- toolbar. NOTE: #status, #log-popup, #btn-*, #engine-select must live OUTSIDE [data-swap] regions.
  const statusEl = $('status'), logEl = $('log-popup'), genBtn = $('btn-generate'), engineSel = $('engine-select');
  function setStatus(t, bad) { statusEl.textContent = t; statusEl.classList.toggle('error', !!bad); }
  $('btn-logs').onclick = () => { logEl.hidden = !logEl.hidden; };
  $('btn-archive').onclick = () => { location.href = u('/archive') + location.search; }; // keeps ?embed= / ?theme=
  // delegated: #brief-select's options are replaced by the in-place swap
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'brief-select') location.href = u(`/brief/${e.target.value}`) + location.search;
  });

  // ---- generation state
  const GM = window.GenModel || null;
  const panel = $('gen-panel');                          // optional
  let jobId = 0, offset = 0, pseq = -1;
  let lastPreview = null, startedAtS = 0, commitStartS = null, shownFrac = 0, clock = null;
  const deskStartS = {};
  const nowS = () => Date.now() / 1000;
  const baseTitle = document.title;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = baseTitle; });

  const deskBox = (n) => [...document.querySelectorAll('[data-desk-stories]')].find((el) => el.dataset.deskStories === n);
  const deskDeck = (n) => [...document.querySelectorAll('[data-desk-deck]')].find((el) => el.dataset.deskDeck === n);

  const skeleton = (n) => Array.from({ length: n }, (_, i) =>
    `<div class="gen-skel${i === 0 ? ' gen-skel--lead' : ''}" aria-hidden="true">` +
    '<div class="gen-skel-line gen-skel-line--title"></div><div class="gen-skel-line"></div>' +
    '<div class="gen-skel-line"></div><div class="gen-skel-line gen-skel-line--short"></div></div>').join('');

  /** Replace a desk's cards with a short cross-fade. A newer call wins (token), so bursts can't interleave. */
  function setBoxHtml(box, html) {
    const tok = box._tok = (box._tok || 0) + 1;
    const hadContent = !!box.firstElementChild && !box.classList.contains('is-skeleton');
    const put = () => {
      if (box._tok !== tok) return;
      box.innerHTML = html;
      box.classList.add('gen-swap-in');
      setTimeout(() => { if (box._tok === tok) box.classList.remove('gen-swap-in'); }, 350);
    };
    if (!hadContent) return put();
    box.classList.add('gen-swap-out');
    setTimeout(() => { if (box._tok === tok) box.classList.remove('gen-swap-out'); put(); }, 150);
  }

  function applyPreview(pv) {
    if (pv.phase === 'committing' && commitStartS == null) commitStartS = nowS();
    for (const [name, d] of Object.entries(pv.desks || {})) {
      if (d.working && deskStartS[name] == null) deskStartS[name] = nowS();
      const box = deskBox(name);
      if (!box) continue;
      if (d.stage === 'pending') {
        if (box.dataset.genState === 'pending') continue;
        box.dataset.genState = 'pending';
        if (box.querySelector('.story-card')) box.classList.add('is-dim');          // keep the old edition, dimmed
        else { box.classList.add('is-skeleton'); box.innerHTML = skeleton(d.n || 5); }
        continue;
      }
      if (box._genHtml !== d.html) {
        box._genHtml = d.html;
        box.dataset.genState = d.stage;
        box.classList.remove('is-dim', 'is-skeleton');
        box.classList.add('is-preview');
        setBoxHtml(box, d.html);
      }
      const deck = deskDeck(name);
      if (deck && d.stage === 'edited' && d.deck) deck.textContent = d.deck;
    }
  }

  // ---- progress panel (optional): bar + step list + one honest sentence
  function renderPanel() {
    if (!panel || !GM) return;
    if (!panel.firstElementChild) {
      panel.innerHTML = '<div class="gen-title" data-g="title"></div>' +
        '<div class="gen-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="gen-bar-fill" data-g="fill"></div></div>' +
        '<ol class="gen-steps" data-g="steps"></ol><div class="gen-note" data-g="note"></div>';
    }
    panel.hidden = false;
    const t = nowS();
    shownFrac = Math.max(shownFrac, GM.fraction(lastPreview, { nowS: t, startS: startedAtS, deskStartS, commitStartS }));
    const g = (k) => panel.querySelector(`[data-g="${k}"]`);
    g('title').textContent = GM.title(lastPreview);
    g('note').textContent = GM.note(lastPreview, t - startedAtS);
    g('fill').style.width = (shownFrac * 100).toFixed(1) + '%';
    g('steps').innerHTML = GM.steps(lastPreview).map((s) => `<li class="gen-step gen-step--${s.state}">${esc(s.label)}</li>`).join('');
  }

  // ---- job watching (single loop used by Generate, "both", and attach-to-running-job)
  async function watchJob() {
    let fails = 0;
    for (;;) {
      let j;
      try { j = await (await fetch(`/api/job?id=${jobId}&since=${offset}&pseq=${pseq}`)).json(); fails = 0; }
      catch { if (++fails > 20) throw new Error('lost contact with the server'); await sleep(1500); continue; }
      if (j.reset) { logEl.textContent = ''; lastPreview = null; pseq = -1; }
      jobId = j.id; offset = j.offset;
      if (j.log) { logEl.textContent += j.log; logEl.scrollTop = logEl.scrollHeight; }
      if (j.preview) { pseq = j.preview.seq; lastPreview = j.preview; applyPreview(j.preview); }
      if (j.status === 'running') { await sleep(700); continue; }
      if (j.status === 'done') return true;
      if (j.status === 'failed') { setStatus(`Generation failed: ${j.error || 'see logs'}`, true); return false; }
      return false; // idle: nothing to watch
    }
  }

  function resetRun() {
    jobId = 0; offset = 0; pseq = -1; lastPreview = null; commitStartS = null; shownFrac = 0;
    for (const k of Object.keys(deskStartS)) delete deskStartS[k];
    startedAtS = nowS();
  }

  async function startJob(engine, label) {
    setStatus(`${label}...`);
    resetRun();
    const r = await post(u('/api/generate'), { engine });
    if (r.status !== 202 && r.status !== 409) { setStatus(`${label} failed to start`, true); return false; }
    return watchJob();
  }

  /** Fetch the finished page and swap every [data-swap] region in place. Falls back to a reload. */
  async function swapToLatest() {
    try {
      const r = await fetch(u('/' + location.search), { cache: 'no-store', headers: { 'X-Session-Id': sessionId } });
      if (!r.ok) throw new Error(String(r.status));
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const regions = [...document.querySelectorAll('[data-swap]')];
      if (!regions.length) throw new Error('page has no [data-swap] regions');
      const incoming = [...doc.querySelectorAll('[data-swap]')];
      for (const el of regions) {
        const next = incoming.find((n) => n.dataset.swap === el.dataset.swap);
        if (next) { el.innerHTML = next.innerHTML; el.classList.add('gen-swap-in'); setTimeout(() => el.classList.remove('gen-swap-in'), 350); }
      }
      const sel = doc.getElementById('brief-select'), st = doc.getElementById('status');
      if (sel && $('brief-select')) $('brief-select').innerHTML = sel.innerHTML;
      if (st) { setStatus(st.textContent.trim(), false); statusEl.className = st.className; }
      const nb = JSON.parse(doc.getElementById('boot').textContent);
      for (const k of Object.keys(stories)) delete stories[k];
      Object.assign(stories, nb.stories);
      boot.briefId = nb.briefId; boot.date = nb.date;
      history.replaceState(null, '', u('/' + location.search));   // we are now showing the latest brief
      applyState();
      return true;
    } catch (err) {
      console.warn('in-place swap failed, reloading:', err);
      location.href = u('/' + location.search);
      return false;
    }
  }

  const previewIsShowing = () => !!document.querySelector('.is-preview,.is-skeleton,.is-dim');

  /** One generation run from click/attach to final swap. `starter` returns true when the job succeeded. */
  async function runFlow(starter) {
    genBtn.disabled = true; engineSel.disabled = true;
    resetRun();
    clock = setInterval(renderPanel, 250); renderPanel();
    let ok = false;
    try { ok = await starter(); }
    catch (err) { setStatus('Generation error: ' + err.message, true); }
    clearInterval(clock); clock = null;
    if (ok) {
      shownFrac = 1; if (panel && GM) panel.querySelector('[data-g="fill"]')?.style.setProperty('width', '100%');
      await swapToLatest();
      if (document.hidden) document.title = '✓ ' + baseTitle;
    } else if (previewIsShowing()) {
      await swapToLatest();                 // job failed: put the last saved edition back (DB is unchanged)
      if (document.hidden) document.title = '⚠ ' + baseTitle;
    }
    if (panel) panel.hidden = true;
    genBtn.disabled = false; engineSel.disabled = false;
  }

  genBtn.onclick = () => runFlow(async () => {
    const engine = engineSel.value;
    if (engine === 'both') {
      // Both engines run back to back; the page only swaps after the LAST one.
      return (await startJob('keyword', 'Keyword brief')) && startJob('lr', 'LR brief');
    }
    return startJob(engine, engine === 'lr' ? 'LR brief' : 'Keyword brief');
  });

  applyState();
  // Attach to a job that is already running (started from another window, or before a page reload).
  fetch(u('/api/job?id=0&since=0&pseq=-1')).then((r) => r.json()).then((j) => {
    if (j.status !== 'running') return;
    runFlow(async () => { startedAtS = (j.preview && j.preview.t0) || nowS(); setStatus('Generating...'); return watchJob(); });
  }).catch(() => { /* server unreachable: nothing to attach to */ });
})();
