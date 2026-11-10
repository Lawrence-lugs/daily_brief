/** Hacker News feed fetcher (port of src/fetch/hn.js).

HN exposes an RSS feed (https://news.ycombinator.com/rss), so HN sources are
configured with kind: "rss" and fetched through the generic fetchRss. This
module keeps the legacy Algolia-based fetchHn for reference but it is not
registered in the FETCHERS registry.
*/
import { Fetcher, makeItem, canonicalUrl, parseDate, stripHtml } from './fetcher.js';

export async function fetchHn(f, spec) {
  const since = Math.floor(Date.now() / 1000) - (f.cfg.hn_lookback_days ?? 45) * 86400;
  const qs = new URLSearchParams({
    query: spec.query,
    tags: 'story',
    hitsPerPage: '30',
    numericFilters: `created_at_i>${since},points>${spec.min_points ?? 0}`,
  }).toString();
  const url = `https://hn.algolia.com/api/v1/search_by_date?${qs}`;
  const text = await f.get(url);
  const data = JSON.parse(text);
  const out = [];
  for (const h of data.hits ?? []) {
    const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    const pts = h.points ?? 1;
    const snippet = stripHtml(h.story_text ?? '') || `Hacker News discussion: ${pts} points, ${h.num_comments ?? 0} comments.`;
    const boost = Math.min(1.0, Math.max(0.6, 0.6 + 0.2 * Math.log10(Math.max(pts, 1))));
    out.push(makeItem(
      url, h.title ?? '', snippet,
      parseDate(h.created_at),
      'Hacker News', spec.subtopic, spec.weight, boost,
      spec.type ?? 'commentary', [],
    ));
  }
  return out;
}
