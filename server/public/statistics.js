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
  api_feeds: renderApiFeeds,
  pv_hist: renderPvHist,
  lr_metrics: renderLrMetrics,
  pca_clusters: renderPcaClusters,
  clusters: renderClusters,
  sessions: renderSessions,
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

function setCardBusy(el, busy) {
  el.querySelectorAll('.stat-action button').forEach((button) => {
    button.disabled = busy;
  });
}

async function onGenerate(el, { live = false } = {}) {
  const id = el.dataset.card;
  const body = el.querySelector('.stat-body');
  setCardBusy(el, true);
  body.textContent = live
    ? 'Fetching API feeds… this can take a minute.'
    : 'Generating…';
  try {
    const res = await fetch(generateUrl(id) + (live ? '?live=1' : ''), {
      method: 'POST',
      headers: { 'X-Brief-Client': '1' },
    });
    if (!res.ok) {
      let errMsg = `Error ${res.status}`;
      try { const e = await res.json(); if (e.error) errMsg = e.error; } catch {}
      body.textContent = errMsg;
      setCardBusy(el, false);
      return;
    }
    const data = await res.json();
    renderCard(el, id, { card: data, outdated: false, currentSourceHash: data.sourceHash });
    setCardBusy(el, false);
  } catch (e) {
    body.textContent = e.message || 'Generation failed';
    setCardBusy(el, false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-card]').forEach((el) => loadCard(el));
  document.querySelectorAll('.stat-generate').forEach((btn) => {
    btn.addEventListener('click', () => onGenerate(btn.closest('[data-card]')));
  });
  document.querySelectorAll('.stat-live').forEach((btn) => {
    btn.addEventListener('click', () => onGenerate(btn.closest('[data-card]'), { live: true }));
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

function formatAge(value, digits = 1) {
  return value == null ? '—' : Number(value).toFixed(digits) + 'd';
}

function ageCellHtml(age) {
  if (!age) return '—';
  const buckets = age.buckets ?? {};
  const fresh7 = Number(buckets.d0_7) || 0;
  const fresh30 = fresh7 + (Number(buckets.d7_30) || 0);
  const lines = [`<div>${age.median == null ? '—' : 'median ' + formatAge(age.median)}</div>`];
  if (age.dated) {
    lines.push(`<div class="api-age-sub">≤7d ${fresh7} · ≤30d ${fresh30}</div>`);
  }
  if (age.max != null) {
    lines.push(`<div class="api-age-sub">max ${formatAge(age.max, 0)}</div>`);
  }
  if (age.undated) {
    lines.push(`<div class="api-age-sub">${age.undated} undated</div>`);
  }
  return `<div class="api-age">${lines.join('')}</div>`;
}

function renderApiFeeds(body, payload) {
  const days = payload?.days ?? [];
  const providers = payload?.providers ?? [];

  if (!days.length) {
    body.textContent = 'No API runs recorded yet. Run a brief or click Test APIs now.';
    return;
  }

  const latest = payload.latest;
  if (!latest || !(latest.feeds ?? []).length) {
    body.textContent = 'No API feeds configured.';
    return;
  }

  const dates = days.map((day) => day.date.slice(5));
  let html = '<div id="plot-api-feeds" class="plotly-graph-div"></div>';
  html += `<div class="caption" style="margin-top:0.35rem;font-size:0.8rem">Items returned per provider per recorded run (sum across feeds). Showing ${days.length} recorded day${days.length === 1 ? '' : 's'}.</div>`;
  html += '<div id="plot-api-age" class="plotly-graph-div"></div>';
  html += '<div class="caption" style="margin-top:0.35rem;font-size:0.8rem">Median item age by provider (item-weighted average of per-feed medians). Dashed line = 7-day fresh threshold.</div>';

  const feeds = [...(latest.feeds ?? [])].sort((a, b) => {
    const rank = (feed) => (feed.ok && !feed.skipped ? 0 : feed.skipped ? 1 : 2);
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });
  html += `<div class="caption" style="margin-top:0.75rem;font-size:0.85rem;color:var(--stat-muted)">Latest run: ${escapeHtml(latest.date)} (${escapeHtml(latest.source)}) — ${latest.ok} ok, ${latest.failed} failed, ${latest.skipped} skipped.</div>`;
  html += '<table><thead><tr><th>Status</th><th>Items</th><th>Age</th><th>Feed</th><th>Note</th></tr></thead><tbody>';
  for (const feed of feeds) {
    const flag = feed.ok && !feed.skipped ? '✅' : feed.skipped ? '⚠️' : '❌';
    const note = feed.error ? escapeHtml(feed.error) : '';
    html += `<tr><td>${flag}</td><td>${feed.itemCount ?? 0}</td><td>${ageCellHtml(feed.age)}</td><td>${escapeHtml(feed.name)}</td><td>${note}</td></tr>`;
  }
  html += '</tbody></table>';

  body.innerHTML = html;

  if (typeof Plotly === 'undefined') {
    body.querySelectorAll('.plotly-graph-div').forEach((plot) => {
      plot.textContent = 'Chart library unavailable.';
    });
    return;
  }

  const traces = providers.map((provider) => ({
    type: 'bar',
    name: provider.name,
    x: dates,
    y: days.map((day) => day.providerCounts?.[provider.key] ?? 0),
    customdata: days.map((day) => day.date),
    hovertemplate: '%{customdata}<br>' + escapeHtml(provider.name) + ': %{y} items<extra></extra>',
  }));

  Plotly.newPlot('plot-api-feeds', traces, themedLayout({
    barmode: 'group',
    margin: { l: 44, r: 12, t: 8, b: 56 },
    xaxis: { type: 'category', tickangle: -45 },
    yaxis: { title: { text: 'Items returned' }, rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.3 },
  }), { displayModeBar: false });

  const hasAge = days.some((day) =>
    Object.values(day.providerAge ?? {}).some((value) => value != null));
  const agePlot = body.querySelector('#plot-api-age');
  if (!hasAge) {
    if (agePlot) agePlot.textContent = 'No age data recorded yet. Run a brief or click Test APIs now.';
    return;
  }

  const theme = currentPlotTheme();
  const ageTraces = providers.map((provider) => ({
    type: 'scatter',
    mode: 'lines+markers',
    name: provider.name,
    x: dates,
    y: days.map((day) => day.providerAge?.[provider.key] ?? null),
    customdata: days.map((day) => day.date),
    connectgaps: false,
    hovertemplate: '%{customdata}<br>' + escapeHtml(provider.name) + ': %{y:.1f} days<extra></extra>',
  }));

  Plotly.newPlot('plot-api-age', ageTraces, themedLayout({
    margin: { l: 44, r: 12, t: 8, b: 48 },
    xaxis: { type: 'category', tickangle: -45 },
    yaxis: { title: { text: 'Median age (days)' }, rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.3 },
    shapes: [{
      type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 7, y1: 7,
      line: { color: theme.line, dash: 'dot', width: 1 },
    }],
    annotations: [{
      xref: 'paper', x: 1, y: 7, text: '7d fresh', showarrow: false,
      xanchor: 'right', yanchor: 'bottom', font: { size: 10, color: theme.font },
    }],
  }), { displayModeBar: false });
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

function renderSessions(body, payload) {
  const {
    sessions = [], nSessions = 0, totalLikes = 0, totalSaves = 0,
    likeDist = { x: [], y: [] }, saveDist = { x: [], y: [] },
  } = payload ?? {};

  if (!nSessions) {
    body.textContent = 'No sessions recorded yet.';
    return;
  }

  let html = `<div class="caption" style="margin-bottom:0.5rem;font-size:0.85rem;color:var(--stat-muted)">${nSessions} unique session${nSessions === 1 ? '' : 's'} — ${totalLikes} like${totalLikes === 1 ? '' : 's'}, ${totalSaves} save${totalSaves === 1 ? '' : 's'}. Showing up to ${sessions.length} most active.</div>`;
  html += '<table><thead><tr><th>Session</th><th>Likes</th><th>Saves</th><th>Total</th></tr></thead><tbody>';
  for (const s of sessions) {
    html += `<tr><td><code>${escapeHtml(s.sessionId)}</code></td><td>${s.likes}</td><td>${s.saves}</td><td>${s.total}</td></tr>`;
  }
  html += '</tbody></table>';
  html += '<div id="plot-sessions" class="plotly-graph-div" style="margin-top:0.75rem"></div>';
  html += '<div class="caption" style="margin-top:0.35rem;font-size:0.8rem">Sessions by number of likes or saves. Only sessions with at least one like or save are listed.</div>';
  body.innerHTML = html;

  if (typeof Plotly === 'undefined') {
    body.querySelectorAll('.plotly-graph-div').forEach((plot) => {
      plot.textContent = 'Chart library unavailable.';
    });
    return;
  }

  const categories = [...new Set([...likeDist.x, ...saveDist.x])].sort((a, b) => a - b);

  Plotly.newPlot('plot-sessions', [
    {
      type: 'bar', name: 'Likes', x: likeDist.x, y: likeDist.y,
      hovertemplate: '%{x} like(s): %{y} session(s)<extra></extra>',
    },
    {
      type: 'bar', name: 'Saves', x: saveDist.x, y: saveDist.y,
      hovertemplate: '%{x} save(s): %{y} session(s)<extra></extra>',
    },
  ], themedLayout({
    barmode: 'group',
    margin: { l: 44, r: 12, t: 8, b: 52 },
    xaxis: {
      type: 'category',
      categoryorder: 'array',
      categoryarray: categories.map(String),
      title: { text: 'Likes or saves per session', standoff: 8 },
    },
    yaxis: { title: { text: 'Sessions' }, rangemode: 'tozero', dtick: 1 },
    legend: { orientation: 'h', y: -0.28 },
  }), { displayModeBar: false });
}
