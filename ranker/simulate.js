// Ephemeral Monte-Carlo preview: no LLM, no fetch, no writes. Feed it candidates from prepareCandidates().
import { selectBrief, mulberry32 } from './sampler.js';

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function applyOverrides(cfg, sets = []) {            // --set sampling.epsilon=0.1 --set ranker.model.prior.default.prec=2
  for (const s of sets) {
    const eq = s.indexOf('='); const ks = s.slice(0, eq).split('.');
    let o = cfg; for (const k of ks.slice(0, -1)) o = (o[k] ??= {});
    o[ks.at(-1)] = JSON.parse(s.slice(eq + 1));
  }
  return cfg;
}

export function simulate(cands, samplingCfg, runs = 200, seed0 = 1) {
  const incl = new Map(), perDesk = {}; let prev = null; const jac = [];
  for (let r = 0; r < runs; r++) {
    const out = selectBrief(cands, samplingCfg, mulberry32(seed0 + r));
    const all = new Set();
    for (const [desk, list] of Object.entries(out)) {
      const picks = list.filter((c) => c.mode !== 'reserve');
      (perDesk[desk] ??= []).push({
        meanP: avg(picks.map((c) => c.p)), meanAge: avg(picks.map((c) => c.age_days)),
        explore: picks.length ? picks.filter((c) => c.mode === 'explore').length / picks.length : 0,
        clusters: new Set(picks.map((c) => c.cluster)).size,
      });
      for (const c of picks) { all.add(c.id); incl.set(c.id, (incl.get(c.id) ?? 0) + 1); }
    }
    if (prev) { const inter = [...all].filter((i) => prev.has(i)).length; jac.push(inter / (all.size + prev.size - inter)); }
    prev = all;
  }
  const byId = new Map(cands.map((c) => [c.id, c]));
  return {
    runs, candidates: cands.length, everPicked: incl.size,
    consecutiveJaccard: avg(jac),                                   // 1 = same brief every day, 0 = disjoint
    desks: Object.fromEntries(Object.entries(perDesk).map(([d, rs]) => [d, {
      meanP: avg(rs.map((x) => x.meanP)), meanAgeDays: avg(rs.map((x) => x.meanAge)),
      exploreFrac: avg(rs.map((x) => x.explore)), distinctClusters: avg(rs.map((x) => x.clusters)),
    }])),
    topIncluded: [...incl].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([id, n]) => ({ id, freq: n / runs, p: byId.get(id)?.p, age: byId.get(id)?.age_days, title: byId.get(id)?.title })),
  };
}
