// Sidebar behaviour: collapse/expand, flyout pickers (brief + engine), status dot, error toast.
// Contract with client.js: this file never replaces or re-parents #brief-select, #engine-select, #status or any
// #btn-* element. It only reads them and reacts to changes (MutationObserver), so client.js needs no edits.
// Picking an item sets the hidden <select>'s value and dispatches a bubbling `change`, which is exactly what
// client.js's delegated handler already listens for.
(() => {
  const $ = (id) => document.getElementById(id);
  const base = document.body.dataset.base || '';
  const root = document.documentElement;
  const sb = $('sidebar');
  if (!sb) return;

  const KEY = 'db-sidebar';
  const narrow = window.matchMedia ? matchMedia('(max-width: 719px)') : { matches: false };
  const briefSel = $('brief-select'), engineSel = $('engine-select'), statusEl = $('status'), genBtn = $('btn-generate');
  const toggleBtn = $('sb-toggle'), fab = $('sb-fab'), backdrop = $('sb-backdrop'), toast = $('sb-toast');
  const p2 = (n) => String(n).padStart(2, '0');

  // Keep ?embed= / ?theme= when going back to the latest brief (same contract as list.html's back link).
  $('sb-brand').href = base + '/' + location.search;

  // ---- collapse / expand
  function setState(s, persist = true) {
    root.dataset.sb = s;
    const open = s === 'expanded';
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.title = open ? 'Collapse sidebar' : 'Expand sidebar';
    toggleBtn.querySelector('.sb-label').textContent = open ? 'Collapse' : 'Expand';
    if (persist && !narrow.matches) { try { localStorage.setItem(KEY, s); } catch {} }
    closePop();
  }
  toggleBtn.addEventListener('click', () => setState(root.dataset.sb === 'expanded' ? 'collapsed' : 'expanded'));
  fab.addEventListener('click', () => { setState('expanded', false); $('sb-brief').focus(); });
  backdrop.addEventListener('click', () => setState('collapsed', false));
  const syncTitle = () => setState(root.dataset.sb || 'expanded', false);

  // ---- flyout list (one shared element)
  const pop = document.createElement('div');
  pop.id = 'sb-pop'; pop.className = 'sb-pop'; pop.hidden = true; pop.setAttribute('role', 'listbox');
  document.body.append(pop);
  let popAnchor = null;

  function closePop(refocus) {
    if (pop.hidden) return;
    pop.hidden = true;
    if (popAnchor) { popAnchor.setAttribute('aria-expanded', 'false'); if (refocus) popAnchor.focus(); }
    popAnchor = null;
  }

  /** groups: [{title?, items:[{value,label,meta?}]}] */
  function openPop(anchor, groups, value, onPick, label) {
    closePop();
    pop.setAttribute('aria-label', label);
    pop.textContent = '';
    for (const g of groups) {
      const box = document.createElement('div');
      box.setAttribute('role', 'group');
      if (g.title) {
        const h = document.createElement('div');
        h.className = 'sb-pop-day'; h.textContent = g.title; h.setAttribute('role', 'presentation');
        box.setAttribute('aria-label', g.title); box.append(h);
      }
      for (const it of g.items) {
        const o = document.createElement('div');
        o.className = 'sb-opt'; o.tabIndex = -1; o.dataset.value = it.value;
        o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(it.value === value));
        const a = document.createElement('span'); a.textContent = it.label; o.append(a);
        if (it.meta) { const m = document.createElement('span'); m.className = 'sb-opt-meta'; m.textContent = it.meta; o.append(m); }
        box.append(o);
      }
      pop.append(box);
    }
    popAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const top = Math.max(8, Math.min(r.top, innerHeight - pop.offsetHeight - 8));
    pop.style.left = Math.round(r.right + 8) + 'px'; pop.style.top = Math.round(top) + 'px';
    pop._pick = onPick;
    (pop.querySelector('[aria-selected="true"]') || pop.querySelector('.sb-opt'))?.focus();
  }

  const opts = () => [...pop.querySelectorAll('.sb-opt')];
  pop.addEventListener('click', (e) => {
    const o = e.target.closest('.sb-opt'); if (!o) return;
    const pick = pop._pick; closePop(true); pick(o.dataset.value);
  });
  pop.addEventListener('keydown', (e) => {
    const list = opts(), i = list.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePop(true); }
    else if (e.key === 'Tab') closePop();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && narrow.matches && root.dataset.sb === 'expanded' && pop.hidden) setState('collapsed', false);
  });

  const commit = (sel, v) => {
    if (sel.value === v) return;
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));   // client.js navigates on #brief-select change
    syncAll();
  };

  // ---- brief picker
  const BRIEF_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+\[(.+?)\])?/;
  function dayTitle(key) {
    const now = new Date(), key0 = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (key === key0) return 'Today';
    if (key === `${y.getFullYear()}-${p2(y.getMonth() + 1)}-${p2(y.getDate())}`) return 'Yesterday';
    const [yy, mm, dd] = key.split('-').map(Number);
    return new Date(yy, mm - 1, dd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function briefGroups() {
    const groups = new Map();
    for (const o of briefSel.options) {
      const m = BRIEF_RE.exec(o.textContent.trim());
      const day = m ? dayTitle(m[1]) : 'Briefs';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push({ value: o.value, label: m ? m[2] : o.textContent.trim(), meta: m && m[3] ? m[3] : '' });
    }
    return [...groups].map(([title, items]) => ({ title, items }));
  }
  // Neighbours by timestamp, so stepping stays correct whatever order the <option>s are in.
  function neighbours() {
    const o = [...briefSel.options];
    const key = (x) => (/^\S+\s+\d{2}:\d{2}/.exec(x.textContent.trim()) || [''])[0];
    const order = o.map((_, i) => i).sort((a, b) => key(o[b]).localeCompare(key(o[a])));   // newest first
    const pos = order.indexOf(briefSel.selectedIndex);
    return { older: pos >= 0 ? o[order[pos + 1]] : undefined, newer: pos > 0 ? o[order[pos - 1]] : undefined };
  }
  $('sb-brief').addEventListener('click', (e) => {
    if (popAnchor === e.currentTarget) return closePop();
    openPop(e.currentTarget, briefGroups(), briefSel.value, (v) => commit(briefSel, v), 'Choose brief');
  });
  $('sb-brief').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && pop.hidden) { e.preventDefault(); e.currentTarget.click(); }
  });
  $('sb-prev').addEventListener('click', () => { const n = neighbours().older; if (n) commit(briefSel, n.value); });
  $('sb-next').addEventListener('click', () => { const n = neighbours().newer; if (n) commit(briefSel, n.value); });

  // ---- engine picker: segmented control (expanded) + flyout (collapsed)
  const seg = $('sb-engine-seg');
  function buildSeg() {
    seg.textContent = '';
    for (const o of engineSel.options) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.value = o.value; b.textContent = o.textContent;
      b.addEventListener('click', () => commit(engineSel, o.value));
      seg.append(b);
    }
  }
  $('sb-engine').addEventListener('click', (e) => {
    if (popAnchor === e.currentTarget) return closePop();
    const items = [...engineSel.options].map((o) => ({ value: o.value, label: o.textContent }));
    openPop(e.currentTarget, [{ items }], engineSel.value, (v) => commit(engineSel, v), 'Selection engine');
  });

  // ---- status dot + error toast
  let lastErr = false, toastTimer = 0;
  function syncStatus() {
    const err = statusEl.classList.contains('error');
    const state = err ? 'error' : genBtn.disabled ? 'busy' : statusEl.classList.contains('stale') ? 'stale' : 'ok';
    const dot = $('sb-dot');
    dot.dataset.state = state;
    dot.parentElement.title = statusEl.textContent.trim();
    if (err && !lastErr && (root.dataset.sb === 'collapsed' || narrow.matches)) {
      toast.textContent = statusEl.textContent.trim(); toast.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
    }
    if (!err) toast.hidden = true;
    lastErr = err;
  }

  // ---- mirror state from the hidden controls
  function syncAll() {
    const sel = briefSel.options[briefSel.selectedIndex];
    $('sb-brief-label').textContent = sel ? sel.textContent.trim() : 'No briefs yet';
    $('sb-brief').disabled = !briefSel.options.length;
    const n = briefSel.options.length ? neighbours() : {};
    $('sb-prev').disabled = !n.older; $('sb-next').disabled = !n.newer;
    for (const b of seg.children) { b.setAttribute('aria-pressed', String(b.dataset.value === engineSel.value)); b.disabled = engineSel.disabled; }
    const eng = engineSel.options[engineSel.selectedIndex];
    $('sb-engine').title = 'Selection engine: ' + (eng ? eng.textContent : '');
    $('sb-engine').disabled = engineSel.disabled;
    syncStatus();
  }

  const watch = (el, cfg) => el && new MutationObserver(syncAll).observe(el, cfg);
  watch(briefSel, { childList: true, subtree: true, attributes: true });   // swapToLatest() rewrites its innerHTML
  watch(engineSel, { attributes: true, attributeFilter: ['disabled'] });    // runFlow() disables it while generating
  watch(genBtn, { attributes: true, attributeFilter: ['disabled'] });
  watch(statusEl, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });

  // The Generate icon follows the server-rendered label ("Regenerate" once a brief exists).
  if (/regenerate/i.test(genBtn.textContent)) $('sb-gen-icon').className = 'bi bi-arrow-clockwise';

  buildSeg();
  syncTitle();
  syncAll();
})();
