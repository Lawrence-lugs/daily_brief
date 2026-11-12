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

  // Count-based repeat penalty: shown_decay^times_shown.
  // Never shown => 1 (no penalty). Each showing compounds the decay.
  const shownPenalty = Math.pow(cfg.shown_decay ?? 1, c.times_shown ?? 0);

  return c.p * fresh * dedupe * shownPenalty;
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
 *             stories_per_desk:number, reserve_per_desk:number}
 * @param trace optional (kind, data) => void. Only observes: the picks are the same with or without it.
 * @returns {Object<string, Array>} desk -> picks (mode greedy|explore|reserve), reserves last.
 *   Each desk's picks come only from that desk's clusters (no cross-desk backfill).
 *   A short desk returns fewer picks without error.
 */
export function selectBrief(cands, cfg, rng, trace) {
  const draws = [];
  if (trace) { const base = rng; rng = () => { const v = base(); draws.push(v); return v; }; }
  let kept = cands.filter((c) => c.days_since_shown == null || c.days_since_shown >= cfg.dedupe.hardWindowDays);
  const hardWindowRemoved = cands.length - kept.length;
  let meanP = null;
  let meanCutoffDropped = 0;
  if (cfg.meanCutoff) {
    const ps = kept.map((c) => c.p);
    meanP = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    const before = kept.length;
    kept = kept.filter((c) => c.p >= meanP);
    meanCutoffDropped = before - kept.length;
  }
  const live = kept.map((c) => ({ ...c, V: value(c, cfg) }));
  trace?.('filter', { candidates: cands.length, hardWindowRemoved, live: kept.length, hardWindowDays: cfg.dedupe.hardWindowDays, meanP, meanCutoffDropped });
  const nPerDesk = cfg.stories_per_desk ?? 5;
  const kReserve = cfg.reserve_per_desk ?? 25;

  const pickOne = (pool, desk, stage) => {
    const before = draws.length;
    const snapshot = trace ? [...pool].sort((a, b) => b.V - a.V).slice(0, 3).map((c) => ({ id: c.id, V: c.V })) : null;
    const size = pool.length;
    const { i, mode } = draw(pool, cfg, rng);
    const [c] = pool.splice(i, 1);
    trace?.('draw', { stage, desk, mode, rng: draws.slice(before), poolSize: size, top3: snapshot, id: c.id, V: c.V, cluster: c.cluster, core: c.core });
    return { ...c, mode, desk };
  };

  // Group live candidates by desk (each desk is sampled independently).
  const byDesk = new Map();
  for (const c of live) {
    const desk = c.desk ?? 'misc';
    if (!byDesk.has(desk)) byDesk.set(desk, []);
    byDesk.get(desk).push(c);
  }

  const result = {};
  for (const [desk, pool] of byDesk) {
    // Round-robin over clusters within this desk (random cluster order for the day).
    const byCluster = new Map();
    for (const c of pool) {
      if (!byCluster.has(c.cluster)) byCluster.set(c.cluster, []);
      byCluster.get(c.cluster).push(c);
    }
    const order = shuffle([...byCluster.keys()], rng);
    trace?.('clusters', { desk, order, sizes: order.map((k) => byCluster.get(k).length) });

    const picks = [];
    while (picks.length < nPerDesk && order.some((k) => byCluster.get(k).length)) {
      for (const k of order) {
        if (picks.length >= nPerDesk) break;
        const clusterPool = byCluster.get(k);
        if (clusterPool.length) picks.push(pickOne(clusterPool, desk, desk));
      }
    }

    // Reserves (editor backfill when the LLM rejects an item): best leftovers by V, per desk.
    const used = new Set(picks.map((c) => c.id));
    const leftovers = pool.filter((c) => !used.has(c.id));
    const reserves = leftovers.sort((a, b) => b.V - a.V).slice(0, kReserve).map((c) => ({ ...c, mode: 'reserve', desk }));

    result[desk] = [...picks, ...reserves];
    trace?.('reserves', { desk, ids: reserves.map((c) => ({ id: c.id, V: c.V })) });
  }
  return result;
}

