/** OpenAlex Works API fetcher for selected solid-state-circuit venues.
 *
 * Uses one source-scoped publication-date query per venue. This avoids a
 * high-volume venue (e.g. JSSC) crowding lower-volume conference proceedings
 * out of a single combined result page. Anonymous requests work; an optional
 * free OPENALEX_API_KEY raises the daily budget.
 */
import { makeItem, parseDate, registerApiFetcher } from './fetcher.js';

const API_URL = 'https://api.openalex.org/works';
const MAX_PAGE_SIZE = 100;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_MAX_PAGES = 1;
const SELECT_FIELDS = [
  'id', 'doi', 'title', 'publication_date', 'created_date', 'publication_year',
  'authorships', 'abstract_inverted_index', 'primary_location', 'topics', 'primary_topic',
].join(',');

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function sourceId(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/(?:openalex\.org\/)?(S\d+)$/i);
  return match ? match[1].toUpperCase() : '';
}

export function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object' || Array.isArray(invertedIndex)) return '';
  const positioned = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const index = Number(position);
      if (Number.isInteger(index) && index >= 0) positioned.push([index, word]);
    }
  }
  positioned.sort((a, b) => a[0] - b[0]);
  return positioned.map(entry => entry[1]).join(' ');
}

export function buildOpenAlexQueryUrl({
  sourceId: selectedSource,
  fromDate,
  toDate,
  perPage = MAX_PAGE_SIZE,
  page = 1,
  apiKey = '',
}) {
  const id = sourceId(selectedSource);
  if (!id) throw new Error('OpenAlex source_id must be an OpenAlex source ID (S...)');
  if (!fromDate || !toDate) throw new Error('OpenAlex publication date bounds are required');

  const params = new URLSearchParams({
    filter: 'primary_location.source.id:' + id + ',from_publication_date:' + fromDate + ',to_publication_date:' + toDate,
    sort: 'publication_date:desc',
    per_page: String(Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(perPage) || MAX_PAGE_SIZE)))),
    page: String(Math.max(1, Math.trunc(Number(page) || 1))),
    select: SELECT_FIELDS,
  });
  if (apiKey) params.set('api_key', apiKey);
  return API_URL + '?' + params.toString();
}

function topicNames(work) {
  const names = [
    work?.primary_topic?.display_name,
    ...(Array.isArray(work?.topics) ? work.topics.map(topic => topic?.display_name) : []),
  ].filter(Boolean);
  return [...new Set(names.map(name => String(name).trim()).filter(Boolean))].slice(0, 6);
}

function authorNames(authorships) {
  if (!Array.isArray(authorships)) return [];
  return authorships.map(row =>
    row?.author?.display_name ?? row?.raw_author_name ?? ''
  ).filter(Boolean);
}

export function mapOpenAlexWork(work, spec) {
  const title = String(work?.title ?? work?.display_name ?? '').trim();
  if (!title) return null;

  const doi = String(work.doi ?? '').trim();
  const landingPage = String(work.primary_location?.landing_page_url ?? '').trim();
  const id = String(work.id ?? '').trim();
  const url = doi || landingPage || id;
  if (!url) return null;

  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const topics = topicNames(work);
  const snippet = [
    topics.length ? 'OpenAlex topics: ' + topics.join('; ') : '',
    abstract,
  ].filter(Boolean).join('\n\n');
  const sourceName = work.primary_location?.source?.display_name || spec.name;
  const published = parseDate(work.publication_date);
  const item = makeItem(
    url,
    title,
    snippet,
    published,
    sourceName,
    spec.default_subtopic ?? spec.subtopic ?? null,
    Number(spec.weight ?? 1),
    1.0,
    spec.type ?? 'researchlike',
    authorNames(work.authorships),
  );
  // Retain these on the transient item for diagnostics; the current candidate
  // pool schema stores publication/first-seen dates separately.
  item.openalex_id = id || null;
  item.openalex_created_date = work.created_date || null;
  item.venue_source_id = sourceId(work.primary_location?.source?.id) || sourceId(spec.source_id);
  return item;
}

function safeRequestError(error) {
  const status = String(error?.message ?? '').match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  return new Error(status
    ? 'OpenAlex API request failed (HTTP ' + status + ')'
    : 'OpenAlex API request failed (' + (error?.name ?? 'Error') + ')');
}

export async function fetchOpenAlexItems(fetcher, spec, {
  apiKey = process.env[spec.api_key_env || 'OPENALEX_API_KEY'] || '',
  now = new Date(),
} = {}) {
  if (!sourceId(spec.source_id)) {
    throw new Error(spec.name + ': missing or invalid source_id');
  }

  const lookbackDays = Math.max(1, Math.min(365, Math.trunc(Number(spec.lookback_days) || DEFAULT_LOOKBACK_DAYS)));
  const perPage = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(spec.per_page) || MAX_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.min(10, Math.trunc(Number(spec.max_pages) || DEFAULT_MAX_PAGES)));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const fromDate = ymd(start);
  const toDate = ymd(end);
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = buildOpenAlexQueryUrl({
      sourceId: spec.source_id,
      fromDate,
      toDate,
      perPage,
      page,
      apiKey,
    });

    await fetcher.throttle?.();
    let raw;
    try {
      raw = await fetcher.get(url);
    } catch (error) {
      throw safeRequestError(error);
    }

    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error('OpenAlex returned invalid JSON for ' + spec.name); }

    if (!Array.isArray(payload.results)) {
      throw new Error('OpenAlex response for ' + spec.name + ' has no results array');
    }

    for (const work of payload.results) {
      const item = mapOpenAlexWork(work, spec);
      if (item) items.push(item);
    }

    const total = Number(payload.meta?.count);
    const hasMore = Number.isFinite(total) && page * perPage < total;
    if (payload.results.length < perPage || !hasMore) break;
    if (page === maxPages) {
      console.warn('OpenAlex source ' + spec.name + ' reached max_pages=' + maxPages
        + '; ' + total + ' works matched the publication-date window');
    }
  }

  return items;
}

registerApiFetcher('openalex', fetchOpenAlexItems);
