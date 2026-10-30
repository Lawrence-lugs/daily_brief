// Interest-level + article-level sampling. Pure: candidates in, picks out. Never mutates its input.
// Candidate shape: {id, p, age_days, days_since_shown|null, cluster:number, core:boolean, ...passthrough}
//   p   = model score S (like probability)
//   V   = S * exp(-lambda*age) * dedupe(days_since_shown)        (computed here)

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Half-life freshness with logistic-in-log-age option and
 * logistic repeat recovery. Never shown => no penalty.
 */
export function value(c, cfg) {
  const age = Math.max(0, c.age_days);

  const fresh = cfg.freshness?.model === "exponential"
    ? Math.exp(-Math.LN2 * age / cfg.halfLifeDays)
    : 1 / (1 + Math.exp(
        cfg.freshness.steepness *
        (Math.log1p(age) - Math.log1p(cfg.halfLifeDays))
      ));

  const d = c.days_since_shown;
  const dedupe = d == null
    ? 1
    : 1 / (1 + Math.exp(
        -(d - cfg.dedupe.t0) / cfg.dedupe.scale
      ));

  return c.p * fresh * dedupe;
}

/** One epsilon-greedy draw. Explore weights are V^gamma (flattened) so low scorers keep a real chance. */
export function draw(pool, cfg, rng) {
  if (rng() < cfg.epsilon) {
    const w = pool.map((c) => Math.pow(Math.max(c.V, cfg.explore.floor), cfg.explore.gamma));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return { i, mode: 'explore' }; }
    return { i: pool.length - 1, mode: 'explore' };
  }
  let bi = 0;
  for (let i = 1; i < pool.length; i++) if (pool[i].V > pool[bi].V) bi = i;
  return { i: bi, mode: 'greedy' };
}

/**
 * @param cfg {epsilon, halfLifeDays, dedupe:{hardWindowDays,t0,scale}, explore:{gamma,floor},
 *             slots:{primary,science,reserve}, desks:{core:'primary', side:'science'}}
 * @returns {Object<string, Array>} desk -> picks (mode greedy|explore|reserve), reserves last
 */
export function selectBrief(cands, cfg, rng) {
  const D = cfg.desks;
  const live = cands
    .filter((c) => c.days_since_shown == null || c.days_since_shown >= cfg.dedupe.hardWindowDays)
    .map((c) => ({ ...c, V: value(c, cfg) }));
  const pickOne = (pool, desk) => { const { i, mode } = draw(pool, cfg, rng); const [c] = pool.splice(i, 1); return { ...c, mode, desk }; };

  // --- main research desk: round-robin over core clusters (random cluster order for the day)
  const byCluster = new Map();
  for (const c of live) if (c.core) { if (!byCluster.has(c.cluster)) byCluster.set(c.cluster, []); byCluster.get(c.cluster).push(c); }
  const order = shuffle([...byCluster.keys()], rng);
  const primary = [];
  while (primary.length < cfg.slots.primary && order.some((k) => byCluster.get(k).length)) {
    for (const k of order) {
      if (primary.length >= cfg.slots.primary) break;
      const pool = byCluster.get(k);
      if (pool.length) primary.push(pickOne(pool, D.core));
    }
  }
  // --- side desk: all non-core items as one pool
  const sidePool = live.filter((c) => !c.core);
  const science = [];
  while (science.length < cfg.slots.science && sidePool.length) science.push(pickOne(sidePool, D.side));

  // --- never leave a hole: backfill a short desk from whatever is left
  const used = new Set([...primary, ...science].map((c) => c.id));
  const rest = live.filter((c) => !used.has(c.id));
  for (const [list, n, desk] of [[primary, cfg.slots.primary, D.core], [science, cfg.slots.science, D.side]]) {
    while (list.length < n && rest.length) list.push(pickOne(rest, desk));
  }
  // --- reserves (editor backfill when the LLM rejects an item): best leftovers by V, per desk
  const usedAll = new Set([...primary, ...science].map((c) => c.id));
  const reserve = (pool, desk) => pool.filter((c) => !usedAll.has(c.id)).sort((a, b) => b.V - a.V)
    .slice(0, cfg.slots.reserve).map((c) => ({ ...c, mode: 'reserve', desk }));
  const coreLeft = [...byCluster.values()].flat();
  return {
    [D.core]: [...primary, ...reserve(coreLeft, D.core)],
    [D.side]: [...science, ...reserve(sidePool, D.side)],
  };
}
