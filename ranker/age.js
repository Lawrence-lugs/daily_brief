// Freshness units.
//
// A feed refreshes at its own rhythm: arXiv and Hacker News every few hours, a
// monthly journal once a month. Measuring a journal item's age in *days* punishes
// it for the feed's turnaround, not for being old relative to the issue it came
// from. So freshness is measured in feed cycles instead:
//
//   age_units = floor(age_days / cadence_days)
//
// cadence_days comes from sources.json per feed (integer >= 1, default 1).
// With the default, age_units === age_days and behaviour is exactly as before.
// A monthly journal's current issue is 0 units old (fresh as today's arXiv post);
// last month's issue is 1 unit (fresh as yesterday's arXiv post); the issue
// before that is 2 units, and so on.

/** Anything below 1 (or not a number) means "daily". */
function normalize(days) {
  const n = Number(days);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Age in feed cycles. Missing/invalid cadence means daily. */
export function ageUnits(ageDays, cadenceDays) {
  return Math.floor(Math.max(0, Number(ageDays) || 0) / normalize(cadenceDays));
}

/** Cadence for one feed name; unknown feed => daily. */
export function cadenceFor(map, feed) {
  return map?.get(feed) ?? 1;
}

/**
 * Build a Map of feed spec name -> cadence_days from a parsed sources.json.
 * Covers both feeds.api (object of arrays) and feeds.rss (array).
 */
export function cadenceMapFromSources(src) {
  const map = new Map();
  const feeds = src?.feeds ?? {};
  const specs = [
    ...Object.values(feeds.api ?? {}).filter(Array.isArray).flat(),
    ...(Array.isArray(feeds.rss) ? feeds.rss : []),
  ];
  for (const spec of specs) {
    if (spec?.name) map.set(spec.name, normalize(spec.cadence_days));
  }
  return map;
}
