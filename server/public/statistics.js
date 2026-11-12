// Client for the statistics page: loads card state from GET /api/stats/:id and
// triggers generation via POST /api/restricted/stats/:id/generate (auth boundary).
// ESM (loaded via defer script tag).
const base = document.body.dataset.base || '';
const RESTRICTED_PREFIX = '/api/restricted';

const RENDERERS = {
  feeds: renderFeeds,
  pv_hist: renderPvHist,
  lr_metrics: renderLrMetrics,
  pca_clusters: renderPcaClusters,
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
  ], { barmode: 'overlay', title: 'p / V score histograms', showlegend: true });
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
  const { points, medoids, k, pcaExplainedVariance } = payload;
  const v1 = pcaExplainedVariance && pcaExplainedVariance[0] != null ? (pcaExplainedVariance[0] * 100).toFixed(1) : '?';
  const v2 = pcaExplainedVariance && pcaExplainedVariance[1] != null ? (pcaExplainedVariance[1] * 100).toFixed(1) : '?';
  body.innerHTML = `<div id="plot-pca" class="plotly-graph-div"></div><div class="caption" style="margin-top:0.5rem;font-size:0.85rem">k=${k} interest clusters (ranker medoids)</div>`;

  const clusters = [...new Set(points.map((pt) => pt.cluster))];
  const traces = clusters.map((cid) => {
    const pts = points.filter((pt) => pt.cluster === cid);
    return {
      type: 'scatter', mode: 'markers', name: 'cluster ' + cid,
      x: pts.map((pt) => pt.x), y: pts.map((pt) => pt.y),
      text: pts.map((pt) => escapeHtml(pt.title) + ' (' + escapeHtml(pt.group) + ')'),
      hoverinfo: 'text', marker: { size: 6 },
    };
  });
  traces.push({
    type: 'scatter', mode: 'markers+text', name: 'medoids',
    x: medoids.map((m) => m.x), y: medoids.map((m) => m.y),
    text: medoids.map((m) => 'C' + m.cluster), textposition: 'top center',
    hovertext: medoids.map((m) => escapeHtml(m.title) + ' (medoid, ' + m.size + ' items)'), hoverinfo: 'text',
    marker: { symbol: 'x', size: 14, color: '#000' },
  });
  Plotly.newPlot('plot-pca', traces, {
    margin: { l: 50, r: 16, t: 16, b: 46 },
    xaxis: { title: { text: 'PC1 (' + v1 + '%)', standoff: 8 } },
    yaxis: { title: { text: 'PC2 (' + v2 + '%)', standoff: 8 } },
  });
}
