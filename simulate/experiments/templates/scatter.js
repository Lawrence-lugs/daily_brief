// ---------- LR interest scatter (Chart.js) ----------
// Depends on __DATA__ being inlined as `D` by the HTML writer.
const D = __DATA__;
const k = D.clusters.length;
document.getElementById('sub').textContent =
  D.subtitle + ' \u00b7 PCA projection of interest embeddings, coloured by Ward cluster \u00b7 hover a point for details';

const css = getComputedStyle(document.documentElement);
const fg = css.getPropertyValue('--fg').trim();
const muted = css.getPropertyValue('--muted').trim();
const grid = css.getPropertyValue('--grid').trim();
Chart.defaults.color = muted;

const hue = i => (i * 137.508) % 360;                 // golden-angle spacing: distinct for any k
const fill = (i, a) => `hsl(${hue(i)} 70% 50% / ${a})`;

const kindLabel = k => k === 'perfect' ? 'perfect sample' : 'liked/saved story';

const clusterSets = D.clusters.map((c, i) => ({
  label: `Cluster ${c.id} (n=${c.n})${c.core ? ' \u2022 core' : ''}`,
  data: c.points.map(p => ({
    x: p.x, y: p.y, path: p.path, title: p.title, kind: p.kind, core: p.core, cluster: c.id,
  })),
  backgroundColor: fill(i, 0.6),
  borderColor: fill(i, 1),
  pointRadius: 4, pointHoverRadius: 7, pointHitRadius: 8,
  clusterId: c.id,
}));

// Pseudo-centroids: cluster mean in PCA space, drawn as rotated squares.
const centroidSets = D.clusters.map((c, i) => ({
  label: `Cluster ${c.id} centroid`,
  data: [{x: c.cx, y: c.cy, centroid: true, cluster: c.id, n: c.n}],
  backgroundColor: fill(i, 1),
  borderColor: fg, borderWidth: 2,
  pointStyle: 'rectRot', pointRadius: 9, pointHoverRadius: 12,
  clusterId: c.id,
}));

const scatterChart = new Chart(document.getElementById('c'), {
  type: 'scatter',
  data: {datasets: [...clusterSets, ...centroidSets]},
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {mode: 'nearest', intersect: true},
    onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
    scales: {
      x: {title: {display: true, text: D.xlabel}, grid: {color: grid}, border: {color: grid}},
      y: {title: {display: true, text: D.ylabel}, grid: {color: grid}, border: {color: grid}},
    },
    plugins: {
      legend: {position: 'top', labels: {usePointStyle: true}},
      tooltip: {
        displayColors: false,
        callbacks: {
          title: items => {
            const r = items[0].raw;
            return r.centroid ? `Cluster ${r.cluster} centroid` : (r.title || r.path);
          },
          label: ctx => {
            const r = ctx.raw;
            if (r.centroid) {
              return [`${r.n} notes`, 'Cluster ' + r.cluster];
            }
            return [
              'Cluster ' + r.cluster,
              kindLabel(r.kind) + (r.core ? ' \u2022 core' : ''),
              'id: ' + r.path,
            ];
          },
        },
      },
    },
  },
});

// Expose `fill` for the dendrogram module (inlined after this script).
window.__scatter_fill = fill;
window.__scatter_D = D;
