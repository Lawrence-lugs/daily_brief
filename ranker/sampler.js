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
  // Freshness is measured in feed cycles (see ranker/age.js). Feeds without a
  // cadence_days are daily, so age_units === age_days and this is unchanged.
  const age = Math.max(0, c.age_units ?? c.age_days);

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
function drawExplore(pool, cfg, rng) {
  const w = pool.map((c) => Math.pow(Math.max(c.V, cfg.explore.floor), cfg.explore.gamma));
  let r = rng() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return pool.length - 1;
}

export function draw(pool, cfg, rng) {
  if (rng() < cfg.epsilon) return { i: drawExplore(pool, cfg, rng), mode: 'explore' };
  let bi = 0;
  for (let i = 1; i < pool.length; i++) if (pool[i].V > pool[bi].V) bi = i;
  return { i: bi, mode: 'greedy' };
}

// Stable sort: editorial order among new stories, prior edition order among incumbents.
export function rollingOrder(a, b) {
  return Number(!!a.carried) - Number(!!b.carried) ||
    (a.carried ? a.previousPosition - b.previousPosition : 0);
}

// Slow desks may exhaust a whole journal issue in a few editions. Compare
// recoverable repeats and fresh items on the same scale before allocating slots.
function selectSlowDesk(pool, desk, policy, cfg, rng) {
  const repeatCfg = { ...cfg, shown_decay: policy.repeatWeight };
  const ranked = pool.map(c => {
    const carried = policy.rollover && c.previousDesk === desk;
    const V = value({ ...c, days_since_shown: carried ? null : c.days_since_shown,
      times_shown: carried ? 1 : Math.min(1, c.times_shown ?? 0) }, repeatCfg);
    return { ...c, desk, V, carried };
  }).sort((a, b) => b.V - a.V);
  const terms = (policy.titleTerms ?? []).map(term => ' ' + term.toLowerCase().trim() + ' ');
  const eligible = ranked.filter(c => {
    if (c.V < policy.minValue) return false;
    const text = policy.includeSnippet ? c.title + ' ' + (c.snippet ?? '') : c.title;
    const words = ' ' + (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    return !terms.length || terms.some(term => words.includes(term));
  });
  const used = new Set();
  const picks = [];
  for (let i = 0; i < (cfg.stories_per_desk ?? 5); i++) {
    const explore = rng() < cfg.epsilon;
    const options = (explore ? ranked.filter(c => !c.carried) : eligible).filter(c => !used.has(c.id));
    if (!options.length) continue;
    const c = explore ? options[drawExplore(options, cfg, rng)] : options[0];
    picks.push({ ...c, mode: explore ? 'explore' : 'greedy' });
    used.add(c.id);
  }
  const reserves = eligible.filter(c => !used.has(c.id)).slice(0, cfg.reserve_per_desk ?? 25);
  picks.sort(rollingOrder);
  return [...picks, ...reserves.map(c => ({ ...c, mode: 'reserve' }))];
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
  let kept = cands.filter((c) => c.days_since_shown == null || c.days_since_shown >= cfg.dedupe.hardWindowDays ||
    (cfg.slowDesks?.[c.desk]?.rollover && c.previousDesk === c.desk));
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
    const policy = cfg.slowDesks?.[desk];
    if (policy) {
      result[desk] = selectSlowDesk(pool, desk, policy, cfg, rng);
      continue;
    }
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

