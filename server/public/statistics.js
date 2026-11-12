// Client for the statistics page: loads card state from GET /api/stats/:id and
// triggers generation via POST /api/restricted/stats/:id/generate (auth boundary).
// ESM (loaded via defer script tag).
const base = document.body.dataset.base || '';
const RESTRICTED_PREFIX = '/api/restricted';

// ---- theme: ?theme=dark|light wins, then an explicit saved choice, else follow the OS
// Mirrors client.js / list.js so the statistics page respects the app's dark/light mode.
const THEME_KEY = 'db-theme';
const root = document.documentElement;

// Plotly colors follow the page theme at runtime (no generate-time template).
const PLOT_THEMES = {
  light: { font: '#3b362e', grid: '#e4dccd', line: '#cfc6b6', marker: '#000000' },
  dark: { font: '#cbd5e1', grid: '#263344', line: '#334155', marker: '#f8fafc' },
};
const currentPlotTheme = () => PLOT_THEMES[root.classList.contains('dark') ? 'dark' : 'light'];

function themedLayout(layout = {}) {
  const t = currentPlotTheme();
  const axis = { gridcolor: t.grid, linecolor: t.line, zerolinecolor: t.line };
  return {
    ...layout,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: t.font },
    xaxis: { ...axis, ...layout.xaxis },
    yaxis: { ...axis, ...layout.yaxis },
  };
}

function applyPlotTheme() {
  if (typeof Plotly === 'undefined') return;
  const t = currentPlotTheme();
  document.querySelectorAll('.plotly-graph-div').forEach((div) => {
    if (!div.data) return;
    Plotly.relayout(div, {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      'font.color': t.font,
      'xaxis.gridcolor': t.grid, 'yaxis.gridcolor': t.grid,
      'xaxis.linecolor': t.line, 'yaxis.linecolor': t.line,
      'xaxis.zerolinecolor': t.line, 'yaxis.zerolinecolor': t.line,
    });
    const idx = div.data.findIndex((tr) => tr.name === 'medoids');
    if (idx >= 0) Plotly.restyle(div, { 'marker.color': t.marker }, [idx]);
  });
}

const setTheme = (t) => {
  const c = root.classList;
  c.remove('dark', 'light'); c.add(t === 'dark' ? 'dark' : 'light');
  const tb = document.getElementById('btn-theme');
  if (tb) { tb.setAttribute('aria-pressed', String(t === 'dark')); tb.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; }
  applyPlotTheme();
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
const tb = document.getElementById('btn-theme');
if (tb) tb.onclick = () => {
  const next = root.classList.contains('dark') ? 'light' : 'dark';
  setTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  const p = new URLSearchParams(location.search);
  p.set('theme', next);
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : ''));
};

const RENDERERS = {
  feeds: renderFeeds,
  pv_hist: renderPvHist,
  lr_metrics: renderLrMetrics,
  pca_clusters: renderPcaClusters,
  clusters: renderClusters,
};

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

function statsUrl(id) { return base + '/api/stats/' + id; }
function generateUrl(id) { return base + RESTRICTED_PREFIX + '/stats/' + id + '/generate'; }

function setEmptyState(el) {
  const body = el.querySelector('.stat-body');
  const btn = el.querySelector('.stat-generate');
  body.textContent = 'Not generated yet';
  body.className = 'stat-body empty';
  btn.textContent = 'Generate';
  btn.disabled = false;
  el.querySelector('.stat-meta').textContent = '';
  el.querySelector('.stat-outdated').hidden = true;
}

function setGeneratedState(el) {
  const body = el.querySelector('.stat-body');
  body.className = 'stat-body';
  el.querySelector('.stat-generate').textContent = 'Regenerate';
}

async function loadCard(el) {
  const id = el.dataset.card;
  const body = el.querySelector('.stat-body');
  const btn = el.querySelector('.stat-generate');
  try {
    const res = await fetch(statsUrl(id));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderCard(el, id, data);
  } catch {
    setEmptyState(el);
  }
}

function renderCard(el, id, data) {
  const body = el.querySelector('.stat-body');
  const meta = el.querySelector('.stat-meta');
  const outdated = el.querySelector('.stat-outdated');

  if (!data.card) {
    setEmptyState(el);
    return;
  }

  const generatedAt = data.card.generatedAt ? new Date(data.card.generatedAt).toLocaleString() : '';
  meta.textContent = generatedAt ? 'Generated ' + generatedAt : '';
  outdated.hidden = !data.outdated;

  setGeneratedState(el);
  const renderer = RENDERERS[id];
  if (renderer) renderer(body, data.card.payload);
  else body.textContent = '(no renderer for ' + id + ')';
}

async function onGenerate(el) {
  const id = el.dataset.card;
  const btn = el.querySelector('.stat-generate');
  const body = el.querySelector('.stat-body');
  btn.disabled = true;
  body.textContent = 'Generating…';
  try {
    const res = await fetch(generateUrl(id), { method: 'POST', headers: { 'X-Brief-Client': '1' } });
    if (!res.ok) {
      let errMsg = `Error ${res.status}`;
      try { const e = await res.json(); if (e.error) errMsg = e.error; } catch {}
      body.textContent = errMsg;
      btn.disabled = false;
      return;
    }
    const data = await res.json();
    renderCard(el, id, { card: data, outdated: false, currentSourceHash: data.sourceHash });
  } catch (e) {
    body.textContent = e.message || 'Generation failed';
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-card]').forEach((el) => loadCard(el));
  document.querySelectorAll('.stat-generate').forEach((btn) => {
    btn.addEventListener('click', () => onGenerate(btn.closest('[data-card]')));
  });
});

if (typeof Plotly !== 'undefined') {
  window.addEventListener('resize', () => {
    document.querySelectorAll('.plotly-graph-div').forEach((div) => Plotly.Plots.resize(div));
  });
}

// ---- per-card renderers ----

function renderFeeds(body, payload) {
  const { rows, totals } = payload;
  const sorted = [...rows].sort((a, b) => {
    const aOk = a.ok && a.feedValid;
    const bOk = b.ok && b.feedValid;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return 0;
  });
  let html = `<div class="totals" style="margin-bottom:0.5rem;font-weight:600">Totals: ${totals.total} feeds | OK: ${totals.ok} | Blocked: ${totals.blocked} | Failed: ${totals.failed}</div>`;
  html += `<table><thead><tr><th>Status</th><th>HTTP</th><th>Items</th><th>Block reason</th><th>Source</th></tr></thead><tbody>`;
  for (const r of sorted) {
    const flag = r.ok && r.feedValid ? '✅' : r.blocked ? '🚫' : '❌';
    const items = r.ok && r.feedValid ? r.itemCount : 0;
    const reason = escapeHtml(r.blockReason ?? '—');
    html += `<tr><td>${flag}</td><td>${escapeHtml(r.status ?? 'n/a')}</td><td>${items}</td><td>${reason}</td><td>${escapeHtml(r.name)}</td></tr>`;
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}

function renderPvHist(body, payload) {
  const { p, V, n, pMean, pMedian, vMean, vMedian } = payload;
  body.innerHTML = `<div id="plot-pv" class="plotly-graph-div"></div><div class="caption" style="margin-top:0.5rem;font-size:0.85rem">n=${n} — p: mean=${pMean} median=${pMedian} | V: mean=${vMean} median=${vMedian}</div>`;
  Plotly.newPlot('plot-pv', [
    { x: p, type: 'histogram', name: 'p', opacity: 0.55, xbins: { start: 0, end: 1, size: 0.05 } },
    { x: V, type: 'histogram', name: 'V', opacity: 0.55, xbins: { start: 0, end: 1, size: 0.05 } },
  ], themedLayout({ barmode: 'overlay', title: 'p / V score histograms', showlegend: true }));
}

function renderLrMetrics(body, payload) {
  const { cutoffDate, tags } = payload;
  if (!tags || !tags.length) { body.textContent = 'No model_eval rows yet'; return; }
  let html = `<div class="caption" style="margin-bottom:0.5rem">Cutoff date: ${escapeHtml(cutoffDate)}</div>`;
  for (const tag of tags) {
    html += `<h3 style="margin:1rem 0 0.25rem">${escapeHtml(tag.tag)}</h3>`;
    html += `<table style="margin-bottom:0.75rem"><thead><tr><th></th><th>AUC</th><th>logLoss</th></tr></thead><tbody>`;
    html += `<tr><td>prior</td><td>${tag.prior.auc == null ? '—' : tag.prior.auc.toFixed(4)}</td><td>${tag.prior.logLoss == null ? '—' : tag.prior.logLoss.toFixed(4)}</td></tr>`;
    html += `<tr><td>keyword</td><td>${tag.keyword.auc == null ? '—' : tag.keyword.auc.toFixed(4)}</td><td>${tag.keyword.logLoss == null ? '—' : tag.keyword.logLoss.toFixed(4)}</td></tr>`;
    html += `<tr><td>fitted</td><td>${tag.fitted.auc == null ? '—' : tag.fitted.auc.toFixed(4)}</td><td>${tag.fitted.logLoss == null ? '—' : tag.fitted.logLoss.toFixed(4)}</td></tr>`;
    html += '</tbody></table>';
  }
  body.innerHTML = html;
}

function renderPcaClusters(body, payload) {
  const { points, medoids, k, explainedVariance } = payload;
  const v1 = explainedVariance && explainedVariance[0] != null ? (explainedVariance[0] * 100).toFixed(1) : null;
  const v2 = explainedVariance && explainedVariance[1] != null ? (explainedVariance[1] * 100).toFixed(1) : null;
  const xTitle = v1 != null ? `PC1 (${v1}%)` : 'UMAP1';
  const yTitle = v2 != null ? `PC2 (${v2}%)` : 'UMAP2';
  body.innerHTML = `<div id="plot-umap" class="plotly-graph-div"></div><div class="caption" style="margin-top:0.5rem;font-size:0.85rem">k=${k} interest clusters (ranker medoids); grey = candidate pool items, assigned to nearest medoid</div>`;

  const clusters = [...new Set(points.filter((pt) => pt.group !== 'pool').map((pt) => pt.cluster))];
  const traces = clusters.map((cid) => {
    const pts = points.filter((pt) => pt.cluster === cid && pt.group !== 'pool');
    return {
      type: 'scatter', mode: 'markers', name: 'cluster ' + cid,
      x: pts.map((pt) => pt.x), y: pts.map((pt) => pt.y),
      text: pts.map((pt) => escapeHtml(pt.title) + ' (' + escapeHtml(pt.group) + ')'),
      hoverinfo: 'text', marker: { size: 6 },
    };
  });
  const poolPts = points.filter((pt) => pt.group === 'pool');
  traces.unshift({
    type: 'scatter', mode: 'markers', name: 'pool',
    x: poolPts.map((pt) => pt.x), y: poolPts.map((pt) => pt.y),
    text: poolPts.map((pt) => escapeHtml(pt.title) + ' (pool, cluster ' + pt.cluster + ')'),
    hoverinfo: 'text', marker: { size: 5, color: '#9ca3af', opacity: 0.6 },
  });
  traces.push({
    type: 'scatter', mode: 'markers+text', name: 'medoids',
    x: medoids.map((m) => m.x), y: medoids.map((m) => m.y),
    text: medoids.map((m) => 'C' + m.cluster), textposition: 'top center',
    hovertext: medoids.map((m) => escapeHtml(m.title) + ' (medoid, ' + m.size + ' items)'), hoverinfo: 'text',
    marker: { symbol: 'x', size: 14, color: currentPlotTheme().marker },
  });
  Plotly.newPlot('plot-umap', traces, themedLayout({
    margin: { l: 50, r: 16, t: 16, b: 46 },
    xaxis: { title: { text: xTitle, standoff: 8 } },
    yaxis: { title: { text: yTitle, standoff: 8 } },
  }));
}

function renderClusters(body, payload) {
  const { clusters } = payload;
  if (!clusters || !clusters.length) { body.textContent = 'No clusters yet'; return; }
  let html = `<div class="caption" style="margin-bottom:0.5rem;font-size:0.85rem;color:var(--stat-muted)">"Liked members" = liked items in the cluster's interest set. "Pool members" = candidate_pool items assigned to the cluster by nearest medoid (as in the ranker).</div><table><thead><tr><th>Cluster</th><th>Medoid</th><th>Liked members</th><th>Pool members</th></tr></thead><tbody>`;
  for (const c of clusters) {
    html += `<tr><td>${escapeHtml(c.cluster)}</td><td>${escapeHtml(c.medoidTitle)}</td><td>${c.likedCount}</td><td>${c.poolCount}</td></tr>`;
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}
