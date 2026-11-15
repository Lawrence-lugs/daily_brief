/** IEEE Xplore Metadata API fetcher.
 *
 * Uses the API's insertion-date filters for delta discovery. The overlapping
 * window tolerates delayed runs without requiring a persistent API cursor.
 */
import {
  makeItem, parseDate, splitAuthors, registerApiFetcher,
} from './fetcher.js';

const API_URL = 'https://ieeexploreapi.ieee.org/api/v1/search/articles';
const MAX_PAGE_SIZE = 200;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_PAGES = 5;

function ymd(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function insertDate(value) {
  const s = String(value ?? '').trim();
  if (/^\d{8}$/.test(s)) {
    return parseDate(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + 'T00:00:00Z');
  }
  return parseDate(s);
}

function publishedDate(article) {
  const publication = String(article.publication_date ?? '').trim();
  // Publication date can have year/month-only precision. In that case use
  // IEEE's insertion date rather than ageing the paper to the first of month.
  const coarse = /^\d{4}(?:[-/]\d{1,2})?$/.test(publication);
  return (publication && !coarse ? parseDate(publication) : null)
    ?? insertDate(article.insert_date)
    ?? parseDate(publication);
}

function authorNames(authors) {
  // Metadata responses expose authors as a list of records with full_name.
  const rows = Array.isArray(authors)
    ? authors
    : (Array.isArray(authors?.authors) ? authors.authors : null);
  if (rows) {
    return rows.map(a => typeof a === 'string'
      ? a
      : (a?.full_name ?? a?.name ?? a?.author ?? '')).filter(Boolean);
  }
  if (authors && typeof authors === 'object') {
    const name = authors.full_name ?? authors.name ?? authors.author ?? '';
    return name ? [String(name)] : [];
  }
  return splitAuthors(String(authors ?? ''));
}

function termsText(value) {
  if (Array.isArray(value)) {
    return value.map(v => typeof v === 'string' ? v : (v?.term ?? v?.value ?? ''))
      .filter(Boolean).join('; ');
  }
  if (value && typeof value === 'object') {
    return [value.author_terms, value.ieee_terms, value.mesh_terms, value.terms, value.term]
      .map(termsText).filter(Boolean).join('; ');
  }
  return String(value ?? '').trim();
}

export function buildIEEEQueryUrl({
  apiKey, publicationNumber, publicationTitle, contentType = 'Early Access',
  startDate, endDate, startRecord = 1, maxRecords = MAX_PAGE_SIZE,
}) {
  if (!apiKey) throw new Error('IEEE Xplore API key is required');
  if (Boolean(publicationNumber) === Boolean(publicationTitle)) {
    throw new Error('Configure exactly one of publication_number or publication_title');
  }
  const params = new URLSearchParams({
    apikey: apiKey,
    content_type: contentType,
    start_date: startDate,
    end_date: endDate,
    max_records: String(Math.max(1, Math.min(MAX_PAGE_SIZE, Number(maxRecords) || MAX_PAGE_SIZE))),
    start_record: String(Math.max(1, Number(startRecord) || 1)),
    format: 'json',
  });
  if (publicationNumber) params.set('publication_number', String(publicationNumber));
  else params.set('publication_title', String(publicationTitle));
  return API_URL + '?' + params.toString();
}

export function mapIEEEArticle(article, spec) {
  const title = String(article?.title ?? article?.article_title ?? '').trim();
  const articleNumber = article?.article_number == null ? '' : String(article.article_number);
  const doi = String(article?.doi ?? '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  const url = articleNumber
    ? 'https://ieeexplore.ieee.org/document/' + encodeURIComponent(articleNumber)
    : (doi ? 'https://doi.org/' + doi : (article?.abstract_url ?? article?.html_url ?? ''));
  if (!title || !url) return null;

  const abstract = String(article.abstract ?? '').trim();
  const terms = [article.index_terms, article.author_terms, article.ieee_terms]
    .map(termsText).filter(Boolean);
  const snippet = [abstract, terms.length ? 'Keywords: ' + terms.join('; ') : '']
    .filter(Boolean).join('\n\n');

  return makeItem(
    url,
    title,
    snippet,
    publishedDate(article),
    spec.name,
    spec.default_subtopic ?? spec.subtopic ?? null,
    Number(spec.weight ?? 1),
    1.0,
    spec.type ?? 'researchlike',
    authorNames(article.authors),
  );
}

function safeRequestError(error) {
  const status = String(error?.message ?? '').match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  return new Error(status
    ? 'IEEE Xplore API request failed (HTTP ' + status + ')'
    : 'IEEE Xplore API request failed (' + (error?.name ?? 'Error') + ')');
}

export async function fetchIEEEItems(fetcher, spec, {
  apiKey = process.env[spec.api_key_env || 'IEEE_XPLORE_API_KEY'],
  now = new Date(),
} = {}) {
  if (!apiKey) {
    const envName = spec.api_key_env || 'IEEE_XPLORE_API_KEY';
    throw new Error('Missing ' + envName + '; IEEE Xplore source ' + spec.name + ' was skipped');
  }
  if (Boolean(spec.publication_number) === Boolean(spec.publication_title)) {
    throw new Error(spec.name + ': configure exactly one of publication_number or publication_title');
  }

  const lookbackDays = Math.max(1, Math.min(365, Math.trunc(Number(spec.lookback_days) || DEFAULT_LOOKBACK_DAYS)));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(spec.max_records) || MAX_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.min(10, Math.trunc(Number(spec.max_pages) || DEFAULT_MAX_PAGES)));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const startDate = ymd(start);
  const endDate = ymd(end);
  const items = [];
  let startRecord = 1;

  for (let page = 0; page < maxPages; page++) {
    const url = buildIEEEQueryUrl({
      apiKey,
      publicationNumber: spec.publication_number,
      publicationTitle: spec.publication_title,
      contentType: spec.content_type || 'Early Access',
      startDate,
      endDate,
      startRecord,
      maxRecords: pageSize,
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
    catch { throw new Error('IEEE Xplore returned invalid JSON for ' + spec.name); }

    const articles = Array.isArray(payload.articles)
      ? payload.articles
      : (Array.isArray(payload.article) ? [payload.article] : null);
    if (!articles) throw new Error('IEEE Xplore response for ' + spec.name + ' has no articles array');

    for (const article of articles) {
      const item = mapIEEEArticle(article, spec);
      if (item) items.push(item);
    }

    const totalFound = Number(payload.totalfound);
    const hasMore = Number.isFinite(totalFound)
      && startRecord + articles.length <= totalFound && articles.length > 0;
    if (articles.length < pageSize || !hasMore) break;
    startRecord += articles.length;

    if (page === maxPages - 1) {
      console.warn('IEEE Xplore source ' + spec.name + ' reached max_pages=' + maxPages
        + '; ' + totalFound + ' records matched the date window');
    }
  }

  return items;
}

registerApiFetcher('ieeexplore', fetchIEEEItems);
