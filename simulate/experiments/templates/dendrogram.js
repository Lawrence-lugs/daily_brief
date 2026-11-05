// ---------- LR Ward dendrogram (plain Canvas 2D) ----------
// Depends on scatter.js running first: output.py inlines scatter.js before
// dendrogram.js, so `fill` and `D` are globals here.

const canC = document.getElementById('c');
const canD = document.getElementById('d');
const ctxD = canD.getContext('2d');
let dendro = null; // {px, py, bottom, leaves, nodes, zoomNode} set by drawDendro()
let zoomNode = null; // linkage index of the zoomed-in clade root, or null.

const tip = document.createElement('div');
Object.assign(tip.style, {
  position: 'fixed', pointerEvents: 'none', zIndex: 1000, padding: '4px 8px',
  borderRadius: '4px', background: 'rgba(0,0,0,0.75)', color: '#fff',
  fontSize: '12px', lineHeight: '1.3', display: 'none', whiteSpace: 'pre-wrap',
  maxWidth: '320px',
});
document.body.appendChild(tip);

const btnZoomOut = document.createElement('button');
btnZoomOut.textContent = '\u2191 Full view';
btnZoomOut.className = 'tbtn';
btnZoomOut.style.display = 'none';
const viewToggle = document.getElementById('view-toggle');
if (viewToggle) viewToggle.parentNode.insertBefore(btnZoomOut, viewToggle);
btnZoomOut.onclick = e => { e.stopPropagation(); zoomOut(); };

function zoomIn(idx) { zoomNode = idx; drawDendro(); }
function zoomOut() { zoomNode = null; drawDendro(); }
function updateZoomUI() {
  btnZoomOut.style.display = (zoomNode !== null && canD.style.display !== 'none') ? '' : 'none';
}

// Leaf (item id) -> final cluster id, to colour dendrogram leaves.
const leafCluster = {};
D.clusters.forEach((c, ci) => { c.points.forEach(p => { leafCluster[p.path] = ci; }); });

const n = D.keys.length;
const links = D.linkage || [];            // [left, right, mergeDistance, clusterSize] (scipy ward scale)
const root = 2 * n - 2;
const children = {};
for (let i = 0; i < links.length; i++) children[n + i] = [links[i][0], links[i][1]];
let maxDist = 0;
for (let i = 0; i < links.length; i++) maxDist = Math.max(maxDist, links[i][2]);
if (!maxDist) maxDist = 1;

// Model cut height, scaled to the scipy linkage scale used by `links`.
// Python passes stop_height already converted to this scale (or null).
const stopHeight = D.stop_height != null ? +D.stop_height : null;

// Post-order slot assignment for every node (leaves and merges).
const xs = new Float64Array(2 * n - 1);
if (links.length === n - 1) {
  let nextSlot = 0;
  const assignStack = [{node: root, visited: false}];
  while (assignStack.length) {
    const frame = assignStack.pop();
    if (frame.node < n) { xs[frame.node] = nextSlot++; continue; }
    if (!frame.visited) {
      assignStack.push({node: frame.node, visited: true});
      const [cl, cr] = children[frame.node];
      assignStack.push({node: cr, visited: false});
      assignStack.push({node: cl, visited: false});
    } else {
      const [cl, cr] = children[frame.node];
      xs[frame.node] = (xs[cl] + xs[cr]) / 2;
    }
  }
}

function cladeLeaves(node, limit) {
  const out = [];
  const stack = [node];
  while (stack.length && out.length <= limit) {
    const cur = stack.pop();
    if (cur < n) { out.push(cur); continue; }
    const [cl, cr] = children[cur];
    stack.push(cr, cl);
  }
  return out;
}

function cladeMembers(rootNode) {
  const nodes = [], leaves = [];
  const stack = [rootNode];
  while (stack.length) {
    const cur = stack.pop();
    if (cur < n) { leaves.push(cur); continue; }
    nodes.push(cur);
    const [cl, cr] = children[cur];
    stack.push(cr, cl);
  }
  return {nodes, leaves};
}

function sizeCanvas(can) {
  const dpr = window.devicePixelRatio || 1;
  const rect = can.getBoundingClientRect();
  can.width = Math.max(1, rect.width * dpr);
  can.height = Math.max(1, rect.height * dpr);
  ctxD.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawDendro() {
  sizeCanvas(canD);
  const w = canD.clientWidth, h = canD.clientHeight;
  const left = 10, top = 30, bottom = h - 32;
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#999';
  ctxD.clearRect(0, 0, w, h);
  dendro = null;
  if (n < 2 || links.length === 0) { updateZoomUI(); return; }

  let viewLeaves, viewNodes, rootDist;
  if (zoomNode === null) {
    viewLeaves = Array.from({length: n}, (_, i) => i);
    viewNodes = Array.from({length: links.length}, (_, i) => n + i);
    rootDist = maxDist;
  } else {
    const m = cladeMembers(n + zoomNode);
    viewLeaves = m.leaves;
    viewNodes = m.nodes;
    rootDist = links[zoomNode][2] || 1;
  }

  const xsView = new Float64Array(2 * n - 1);
  const scaleX = (w - 2 * left) / Math.max(1, viewLeaves.length - 1);
  if (zoomNode === null) {
    xsView.set(xs);
  } else {
    viewLeaves.forEach((leaf, k) => { xsView[leaf] = k; });
    viewNodes.slice().sort((a, b) => a - b).forEach(node => {
      const [cl, cr] = children[node];
      xsView[node] = (xsView[cl] + xsView[cr]) / 2;
    });
  }
  const px = node => left + xsView[node] * scaleX;
  const py = node => node < n ? bottom : bottom - (links[node - n][2] / rootDist) * (bottom - top);

  dendro = {px, py, bottom, leaves: viewLeaves, nodes: viewNodes, links, zoomNode};

  // model cut-height line (full view only)
  if (stopHeight != null && zoomNode === null) {
    const pyCut = bottom - (stopHeight / maxDist) * (bottom - top);
    if (pyCut >= top && pyCut <= bottom) {
      ctxD.strokeStyle = '#c0392b';
      ctxD.lineWidth = 1.5;
      ctxD.setLineDash([6, 4]);
      ctxD.beginPath(); ctxD.moveTo(left, pyCut); ctxD.lineTo(w - left, pyCut); ctxD.stroke();
      ctxD.setLineDash([]);
      ctxD.fillStyle = '#c0392b';
      ctxD.font = '10px system-ui, sans-serif';
      ctxD.textAlign = 'left';
      ctxD.fillText('model cut = ' + stopHeight.toFixed(3), left + 4, pyCut - 5);
    }
  }

  // merge lines.
  ctxD.strokeStyle = muted;
  ctxD.lineWidth = 1;
  for (const node of viewNodes) {
    const i = node - n;
    const [l, r] = links[i];
    const ny = py(node);
    ctxD.beginPath();
    ctxD.moveTo(px(l), py(l)); ctxD.lineTo(px(l), ny);
    ctxD.moveTo(px(r), py(r)); ctxD.lineTo(px(r), ny);
    ctxD.moveTo(px(l), ny); ctxD.lineTo(px(r), ny);
    ctxD.stroke();
  }

  // distance axis on the left.
  ctxD.fillStyle = muted;
  ctxD.font = '10px system-ui, sans-serif';
  ctxD.textAlign = 'right';
  ctxD.fillText((zoomNode === null ? maxDist : rootDist).toFixed(3), left - 6, top + 11);
  ctxD.fillText('0', left - 6, bottom + 2);
  ctxD.textAlign = 'left';
  ctxD.fillText('merge distance', left + 6, top - 8);

  // leaves, coloured by their final cluster.
  for (const i of viewLeaves) {
    ctxD.fillStyle = fill(leafCluster[D.keys[i]] ?? 0, 1);
    ctxD.beginPath(); ctxD.arc(px(i), bottom, 3.5, 0, Math.PI * 2); ctxD.fill();
  }
  // merge nodes.
  ctxD.fillStyle = '#5b5f66';
  for (const node of viewNodes) {
    ctxD.beginPath(); ctxD.arc(px(node), py(node), 2.5, 0, Math.PI * 2); ctxD.fill();
  }

  // rotated leaf labels (skipped when they would crowd).
  if (viewLeaves.length <= 150) {
    ctxD.font = '9px system-ui, sans-serif';
    ctxD.textAlign = 'right'; ctxD.textBaseline = 'middle';
    ctxD.fillStyle = '#8a9096';
    for (const i of viewLeaves) {
      const p = D.clusters.find(c => c.points.some(pp => pp.path === D.keys[i])) || {};
      const title = (D.clusters.flatMap(c => c.points).find(pp => pp.path === D.keys[i]) || {}).title || '';
      const short = (title.length > 30 ? title.slice(0, 30) + '\u2026' : title);
      ctxD.save();
      ctxD.translate(px(i) + 5, bottom + 7);
      ctxD.rotate(-Math.PI / 2);
      ctxD.fillText(D.keys[i] + (short ? ' \u2014 ' + short : ''), 0, 0);
      ctxD.restore();
    }
  }

  updateZoomUI();
}

function dendroHit(x, y) {
  if (!dendro) return null;
  const {px, py, bottom, leaves, nodes} = dendro;
  const radius = 9;
  for (const i of leaves) {
    if (Math.hypot(x - px(i), y - bottom) < radius) return {kind: 'leaf', idx: i};
  }
  const nodeRadius = 8;
  for (const node of nodes) {
    if (Math.hypot(x - px(node), y - py(node)) < nodeRadius) return {kind: 'node', idx: node - n};
  }
  return null;
}

canD.onmousemove = e => {
  const rect = canD.getBoundingClientRect();
  const h = dendroHit(e.clientX - rect.left, e.clientY - rect.top);
  canD.style.cursor = h ? 'pointer' : 'default';
  if (!h) { tip.style.display = 'none'; return; }
  tip.style.display = 'block';
  const tipX = Math.min(Math.max(e.clientX + 12, 8), window.innerWidth - tip.offsetWidth - 8);
  const tipY = Math.min(Math.max(e.clientY + 12, 8), window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = tipX + 'px';
  tip.style.top = tipY + 'px';
  const allPoints = D.clusters.flatMap(c => c.points);
  if (h.kind === 'leaf') {
    const p = allPoints.find(pp => pp.path === D.keys[h.idx]) || {};
    tip.textContent = D.keys[h.idx] + '\u00b7' + (p.title || '') +
      '\nCluster ' + (leafCluster[D.keys[h.idx]] ?? 0) + ' \u00b7 ' + (p.core ? 'core perfect' : p.kind || '');
  } else {
    const link = links[h.idx];
    const members = cladeLeaves(n + h.idx, 5);
    const more = members.length > 5;
    const names = members.slice(0, 5).map(li => D.keys[li]);
    tip.textContent =
      'Merge distance ' + link[2].toFixed(3) + ' \u00b7 ' + link[3] + ' items\n' +
      'Clade: ' + names.join(', ') + (more ? ' \u2026' : '');
  }
};
canD.onmouseleave = () => { tip.style.display = 'none'; };
canD.onclick = e => {
  if (!dendro) return;
  const rect = canD.getBoundingClientRect();
  const h = dendroHit(e.clientX - rect.left, e.clientY - rect.top);
  if (!h) { if (zoomNode !== null) zoomOut(); return; }
  if (h.kind === 'leaf') {
    // click a leaf: no-op here (scatter view shows details on hover)
    return;
  }
  if (zoomNode !== null && h.idx === zoomNode) zoomOut();
  else zoomIn(h.idx);
};

const btnScatter = document.getElementById('btn-scatter');
const btnDendro = document.getElementById('btn-dendro');
function showView(view) {
  if (view === 'dendro') {
    canC.style.display = 'none'; canD.style.display = '';
    drawDendro();
    btnScatter.classList.remove('active'); btnDendro.classList.add('active');
  } else {
    tip.style.display = 'none';
    canD.style.display = 'none'; canC.style.display = '';
    scatterChart.resize();
    btnDendro.classList.remove('active'); btnScatter.classList.add('active');
  }
  updateZoomUI();
}
btnScatter.onclick = () => showView('scatter');
btnDendro.onclick = () => showView('dendro');
window.addEventListener('resize', () => {
  scatterChart.resize();
  if (canD.style.display !== 'none') drawDendro();
});
