/** Epsilon-greedy item selection with soft (logistic) staleness (port of src/selection.js).

Pure functions, no I/O. Behaviour matches the Python original.

Item fields used:
  rel          float in (0,1]  base relevance
  age_days     float >= 0      computed by caller at selection time
  subtopic     str
  times_shown  int
  rejected     int
  source_type  str
*/
export const DEFAULTS = {
  epsilon: 0.25,
  a50_days: 7.0,
  slope: 1.0,
  age_floor_days: 0.25,
  explore_gamma: 0.3,
  shown_decay: 0.05,
  rejected_decay: 0.3,
  archive_after_days: 7.0,
  skip_exhausted_subtopics: true,
};

export function freshness(ageDays, cfg) {
  const a = Math.max(ageDays, cfg.age_floor_days);
  const z = (Math.log(cfg.a50_days) - Math.log(a)) / cfg.slope;
  return 1 / (1 + Math.exp(-z));
}

function penalty(item, cfg) {
  return Math.pow(cfg.shown_decay, item.times_shown ?? 0) * Math.pow(cfg.rejected_decay, item.rejected ?? 0);
}

export function greedyScore(item, cfg) {
  return item.rel * freshness(item.age_days, cfg) * penalty(item, cfg);
}

export function exploreWeight(item, cfg) {
  return item.rel * Math.pow(freshness(item.age_days, cfg), cfg.explore_gamma) * penalty(item, cfg);
}

function draw(pool, cfg, rng) {
  if (rng() < cfg.epsilon) {
    const weights = pool.map(i => exploreWeight(i, cfg));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let r = rng() * total;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) return [pool[i], 'explore'];
      }
      return [pool[pool.length - 1], 'explore'];
    }
  }
  let best = pool[0];
  let bestScore = greedyScore(pool[0], cfg);
  for (let i = 1; i < pool.length; i++) {
    const s = greedyScore(pool[i], cfg);
    if (s > bestScore) { best = pool[i]; bestScore = s; }
  }
  return [best, 'greedy'];
}

export function pickDesk(candidates, subtopics, n, cfg, rng, minimumTypes = null) {
  const skipExhausted = cfg.skip_exhausted_subtopics !== false;
  const remaining = candidates.filter(c => subtopics.includes(c.subtopic));
  const counts = {};
  for (const s of subtopics) counts[s] = 0;
  const typeCounts = {};
  let neededTypes = null;
  const picks = [];

  while (remaining.length && picks.length < n) {
    neededTypes = null;
    if (minimumTypes) {
      neededTypes = {};
      for (const [kind, minimum] of Object.entries(minimumTypes)) {
        if (typeCounts[kind] < minimum && remaining.some(c => c.source_type === kind)) {
          neededTypes[kind] = true;
        }
      }
    }
    const pools = {};
    for (const s of subtopics) {
      pools[s] = remaining.filter(c => c.subtopic === s && (!neededTypes || c.source_type in neededTypes));
    }
    const nonempty = subtopics.filter(s => pools[s].length);
    if (!nonempty.length) break;
    let orderPool = nonempty;
    if (skipExhausted) {
      const fresh = nonempty.filter(s => pools[s].some(c => (c.times_shown ?? 0) === 0));
      if (fresh.length) orderPool = fresh;
    }
    orderPool.sort((a, b) => counts[a] - counts[b] || rng() - 0.5);
    const pool = pools[orderPool[0]];
    const [item, mode] = draw(pool, cfg, rng);
    const idx = remaining.indexOf(item);
    if (idx >= 0) remaining.splice(idx, 1);
    counts[item.subtopic] = (counts[item.subtopic] || 0) + 1;
    if (item.source_type) typeCounts[item.source_type] = (typeCounts[item.source_type] || 0) + 1;
    picks.push([item, mode]);
  }
  return picks;
}

export function pickReserves(candidates, takenIds, k, cfg, minimumTypes = null) {
  const left = candidates.filter(c => !takenIds.has(c.id));
  left.sort((a, b) => greedyScore(b, cfg) - greedyScore(a, cfg));
  const reserves = [];
  if (minimumTypes) {
    for (const [kind, minimum] of Object.entries(minimumTypes)) {
      const matching = left.filter(c => c.source_type === kind);
      for (const item of matching.slice(0, minimum)) {
        if (reserves.length >= k) break;
        reserves.push(item);
        const idx = left.indexOf(item);
        if (idx >= 0) left.splice(idx, 1);
      }
    }
  }
  return [...reserves, ...left].slice(0, k);
}

export function kindOf(item, cfg) {
  return item.age_days > cfg.archive_after_days ? 'archive' : 'fresh';
}
