// Formatting for the card backside. Pure: story row (as returned by queries.getBrief, plus the optional
// medoid_title resolved in app.js) -> flat object of display strings for templates/story-back.html.
// Every value goes through render.js fill(), which HTML-escapes it, so do NOT pre-escape here.
const DASH = '\u2014';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Scores like p / V: 3 decimals, scientific notation below 0.001 so tiny V values stay readable. */
export function fmtScore(x) {
  if (!isNum(x)) return DASH;
  if (x !== 0 && Math.abs(x) < 0.001) return x.toExponential(1);
  return x.toFixed(3);
}
export const fmtCount = (x) => (isNum(x) ? String(Math.round(x)) : DASH);
export const fmtDist = (x) => (isNum(x) ? x.toFixed(3) : DASH);

export function formatBackside(s) {
  const hasData = [s.score_p, s.score_v, s.cos_dist, s.cluster_size, s.cluster_pool].some(isNum) || !!s.medoid_id;
  const pool = isNum(s.cluster_pool)
    ? `${fmtCount(s.cluster_pool)} candidates` + (isNum(s.cluster_size) ? ` \u00b7 ${fmtCount(s.cluster_size)} interest points` : '')
    : DASH;
  return {
    pool,
    p: fmtScore(s.score_p),
    v: fmtScore(s.score_v),
    // Snapshot only. Deliberately NOT falling back to s.clusterMedoidTitle: that one is looked up from the
    // CURRENT interests and can belong to a different cluster for an older brief.
    medoid: s.medoid_title || s.medoid_id || DASH,
    dist: fmtDist(s.cos_dist),
    note: hasData ? '' : 'No ranker data for this card (keyword engine, or a brief made before this view existed).',
  };
}
