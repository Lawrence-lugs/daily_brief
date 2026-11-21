// jsdom test for the clustering (UMAP) hover labels: titles come first, long
// titles are clipped, and perfect-sample ids (ps:N) are appended as metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SCRIPT = readFileSync(new URL('../public/statistics.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LONG = 'Zigzag: Enlarging joint architecture-mapping design space exploration for dnn accelerators';
const POINTS = [
  { id: 'ps:1', title: LONG, group: 'perfect', cluster: 0, x: 0, y: 0 },
  { id: 'item-1', title: 'Short liked', group: 'liked', cluster: 0, x: 1, y: 0 },
  { id: 'item-2', title: 'A pool item', group: 'pool', cluster: 1, x: 2, y: 0 },
];
const MEDOIDS = [{ id: 'ps:1', cluster: 0, title: LONG, x: 0, y: 0, size: 7 }];

const PAGE = `<!doctype html><html><head></head><body data-base="">
<section class="stat-card" data-card="pca_clusters">
  <header><h2>Clustering (UMAP)</h2></header>
  <div class="stat-body">Not generated yet</div>
  <footer><span class="stat-meta"></span><span class="stat-outdated" hidden>Outdated</span></footer>
  <div class="stat-action"><button type="button" class="stat-generate">Generate</button></div>
</section></body></html>`;

test('clustering hover: title first, clipped, then metadata with ps id last', async () => {
  const dom = new JSDOM(PAGE, {
    url: 'http://localhost/statistics?theme=light',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  let traces = null;

  w.Plotly = {
    newPlot: (_id, t) => { traces = t; },
    relayout: () => {}, restyle: () => {},
    Plots: { resize: () => {} },
  };
  w.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      card: {
        cardId: 'pca_clusters',
        generatedAt: new Date().toISOString(),
        sourceHash: 'h',
        payload: { points: POINTS, medoids: MEDOIDS, k: 2, explainedVariance: null },
      },
      outdated: false,
      currentSourceHash: 'h',
    }),
  });

  w.eval(SCRIPT);
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(30);

  assert.ok(traces, 'Plotly.newPlot was called');
  const byName = Object.fromEntries(traces.map((t) => [t.name, t]));

  const perfect = byName['cluster 0'].text.find((t) => t.includes('(perfect'));
  assert.ok(perfect.startsWith(LONG.slice(0, 72).trimEnd() + '...'), perfect);
  assert.ok(perfect.endsWith('(perfect, ps:1)'), perfect);
  assert.ok(!perfect.startsWith('ps:'), 'never leads with the id');

  assert.equal(byName['cluster 0'].text.find((t) => t.includes('(liked')), 'Short liked (liked)');
  assert.equal(byName.pool.text[0], 'A pool item (pool, cluster 1)');

  const medoid = byName.medoids.hovertext[0];
  assert.ok(medoid.startsWith(LONG.slice(0, 72).trimEnd() + '...'), medoid);
  assert.ok(medoid.endsWith('(medoid, 7 items, ps:1)'), medoid);

  w.close();
});
