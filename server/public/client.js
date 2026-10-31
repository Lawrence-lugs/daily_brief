// Client for the daily-brief page: like/save persistence, Generate + logs, theme, embed bridge.
(() => {
  const boot = JSON.parse(document.getElementById('boot').textContent);
  const stories = boot.stories;
  const $ = (id) => document.getElementById(id);
  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Brief-Client': '1' }, // required by server guard
    body: JSON.stringify(body ?? {}),
  });

  // ---- theme: ?theme=dark|light wins, parent window may update it, else follow the OS
  const setTheme = (t) => {
    const c = document.documentElement.classList;
    c.remove('dark', 'light'); c.add(t === 'dark' ? 'dark' : 'light');
  };
  const qTheme = new URLSearchParams(location.search).get('theme');
  setTheme(qTheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  addEventListener('message', (e) => {
    if (e.source === window.parent && e.data && e.data.type === 'theme') setTheme(e.data.theme);
  });

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
      const r = await post(`/api/stories/${id}/feedback`, { action, value: next });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      s.liked = !!j.liked; s.saved = !!j.saved;
    } catch (err) {
      s[key] = !next;                                  // revert
      setStatus('Could not save: ' + err.message, true);
    }
    applyState();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) { e.preventDefault(); toggle(btn); return; }
    const a = e.target.closest('a[href]');
    if (a && /^https?:/i.test(a.href) && !a.href.startsWith(location.origin)) {
      if (boot.embed) { e.preventDefault(); parent.postMessage({ type: 'open-url', url: a.href }, '*'); }
      else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
  });

  // ---- toolbar
  const statusEl = $('status'), logEl = $('log-popup'), genBtn = $('btn-generate'), engineSel = $('engine-select');
  function setStatus(t, bad) { statusEl.textContent = t; statusEl.classList.toggle('error', !!bad); }
  $('btn-logs').onclick = () => { logEl.hidden = !logEl.hidden; };
  $('btn-archive').onclick = () => { location.href = '/archive' + location.search; }; // keeps ?embed= / ?theme=
  $('brief-select').onchange = (e) => { location.href = `/brief/${e.target.value}${location.search}`; };

  let jobId = 0, offset = 0;
  async function poll() {
    let j;
    try { j = await (await fetch(`/api/job?id=${jobId}&since=${offset}`)).json(); }
    catch { setTimeout(poll, 1500); return; }
    if (j.reset) { logEl.textContent = ''; }
    jobId = j.id; offset = j.offset;
    if (j.log) { logEl.textContent += j.log; logEl.scrollTop = logEl.scrollHeight; }
    if (j.status === 'running') { genBtn.disabled = true; setStatus('Generating...'); setTimeout(poll, 700); return; }
    genBtn.disabled = false;
    if (j.status === 'done') { location.href = '/' + location.search; return; }   // latest brief
    if (j.status === 'failed') setStatus('Generation failed: ' + (j.error || 'see logs'), true);
  }

  async function runGeneration(engine, label) {
    setStatus(`${label}...`);
    jobId = 0; offset = 0;
    const r = await post('/api/generate', { engine });
    if (r.status !== 202 && r.status !== 409) {
      setStatus(`${label} failed to start`, true);
      return false;
    }
    // Wait for completion
    while (true) {
      const j = await (await fetch(`/api/job?id=${jobId}&since=${offset}`)).json();
      if (j.reset) logEl.textContent = '';
      jobId = j.id; offset = j.offset;
      if (j.log) { logEl.textContent += j.log; logEl.scrollTop = logEl.scrollHeight; }
      if (j.status === 'running') { await new Promise(r => setTimeout(r, 700)); continue; }
      if (j.status === 'done') { return true; }
      if (j.status === 'failed') { setStatus(`${label} failed: ${j.error || 'see logs'}`, true); return false; }
    }
  }

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    engineSel.disabled = true;
    const engine = engineSel.value;
    let ok = false;
    if (engine === 'both') {
      ok = await runGeneration('keyword', 'Keyword brief');
      if (ok) ok = await runGeneration('lr', 'LR brief');
    } else {
      ok = await runGeneration(engine, engine === 'lr' ? 'LR brief' : 'Keyword brief');
    }
    genBtn.disabled = false;
    engineSel.disabled = false;
    if (ok) { location.href = '/' + location.search; } // reload to show latest
  };

  applyState();
  // Attach to a job that is already running (e.g. started from another window).
  fetch('/api/job?id=0&since=0').then((r) => r.json()).then((j) => { if (j.status === 'running') poll(); });
})();
