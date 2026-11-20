/** Fetching subsystem (port of src/fetch/fetcher.py).

Provides Throttler, Fetcher, stripHtml, parseDate, canonicalUrl, splitAuthors,
makeItem, parseFeed, fetchRss, FETCHERS registry, API_FETCHERS registry,
registerApiFetcher, refreshApiFeeds, fetchAll.
*/
import crypto from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// CACHE is set by brief.js via setCacheResolver.
let cacheResolver = null;
export function setCacheResolver(fn) { cacheResolver = fn; }
function cacheDir() {
  if (cacheResolver) return cacheResolver();
  return join(homedir(), '.cache', 'daily_brief');
}

export class Throttler {
  constructor(minIntervalS = 0) {
    this.minInterval = Number(minIntervalS);
    this._last = 0;
    this._locked = false;
  }
  async wait() {
    if (this.minInterval <= 0) return;
    if (this._locked) return;
    this._locked = true;
    try {
      const wait = this._last + this.minInterval - Date.now() / 1000;
      if (wait > 0) await new Promise(r => setTimeout(r, wait * 1000));
      this._last = Date.now() / 1000;
    } finally { this._locked = false; }
  }
}

export class Fetcher {
  constructor(cfg, { noCache = false } = {}) {
    this.cfg = cfg;
    this.noCache = noCache;
    this._throttle = new Throttler(cfg.api_delay_s ?? 0);
    this._cacheDir = cacheDir();
    mkdir(this._cacheDir, { recursive: true }).catch(() => {});
  }
  async get(url, useCache = true, headers = null) {
    if (this.noCache) useCache = false;
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    const cacheFile = join(this._cacheDir, hash + '.txt');
    const ttl = (this.cfg.cache_ttl_hours ?? 6) * 3600 * 1000;
    if (useCache) {
      try {
        const st = await stat(cacheFile).catch(() => null);
        if (st && Date.now() - st.mtimeMs < ttl) return await readFile(cacheFile, 'utf8');
      } catch {}
    }
    const reqHeaders = { 'User-Agent': this.cfg.user_agent, ...(headers || {}) };
    const res = await fetch(url, { headers: reqHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    try { await writeFile(cacheFile, text, 'utf8'); } catch {}
    return text;
  }
  throttle() { return this._throttle.wait(); }
}

export function stripHtml(s) {
  if (!s) return '';
  let t = String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let d = new Date(s);
  if (isNaN(d.getTime())) {
    try { d = new Date(s.replace('Z', '+00:00')); } catch { return null; }
  }
  return isNaN(d.getTime()) ? null : d;
}

export function canonicalUrl(url) {
  const u = new URL(url.trim());
  const m = u.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/);
  if (u.hostname.endsWith('arxiv.org') && m) {
    return `https://arxiv.org/abs/${m[1]}`;
  }
  const qs = u.searchParams.toString();
  const keep = [];
  for (const [k, v] of u.searchParams) {
    const kl = k.toLowerCase();
    if (!kl.startsWith('utm_') && kl !== 'fbclid' && kl !== 'ref' && kl !== 'source') keep.push([k, v]);
  }
  const query = keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${u.hostname.toLowerCase()}${pathname}${query ? '?' + query : ''}`;
}

export function splitAuthors(text) {
  text = stripHtml(text || '');
  text = text.replace(/\bet\s+al\./gi, '').trim().replace(/;/g, ',');
  const parts = text.split(/,|\band\b/).map(p => p.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(p => p.includes(' ')) ? parts : (text ? [text] : []);
}

export function makeItem(url, title, snippet, published, source, hintSub, weight, extraRel = 1.0, sourceType = 'researchlike', authors = null) {
  url = canonicalUrl(url);
  return {
    id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 12),
    url,
    title: String(title ?? '').replace(/\s+/g, ' ').trim(),
    snippet: String(snippet ?? '').trim().slice(0, 900),
    published: published ? published.toISOString() : null,
    source,
    source_type: sourceType,
    hint: hintSub,
    weight: weight * extraRel,
    authors: authors ? [...authors] : [],
  };
}

function localTag(tag) {
  return tag.split('}').pop();
}

// Simple regex-based RSS/Atom item extraction (reliable across feed dialects).
function extractItems(xmlText, name, weight, hint, sourceType) {
  const out = [];
  // Split into item/entry blocks
  const itemRegex = /<(item|entry)[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[0];
    const getField = (names) => {
      for (const n of names) {
        const re = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\/${n}>`, 'i');
        const m = block.match(re);
        if (m) return stripHtml(m[1]);
      }
      return '';
    };
    // link: <link href="..."/> or <link>url</link>
    let link = '';
    const linkM = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (linkM) link = linkM[1];
    else {
      const linkTextM = block.match(/<link[^>]*>([^<]+)<\/link>/i);
      if (linkTextM) link = linkTextM[1];
    }
    const title = getField(['title']);
    const body = getField(['content', 'encoded', 'description', 'summary']);
    const dateStr = getField(['pubDate', 'published', 'updated', 'date']);
    // authors
    let authors = [];
    const authorM = block.match(/<(?:creator|author)[^>]*>([\\s\\S]*?)<\/(?:creator|author)>/i);
    if (authorM) authors = splitAuthors(authorM[1]);
    const date = parseDate(dateStr);
    if (title && link.startsWith('http')) {
      out.push(makeItem(link, title, body, date, name, hint, weight, undefined, sourceType, authors));
    }
  }
  return out;
}

export function parseFeed(xmlText, name, weight, hint, sourceType = 'researchlike') {
  return extractItems(xmlText, name, weight, hint, sourceType);
}

export async function fetchRss(f, spec) {
  return parseFeed(await f.get(spec.url), spec.name, spec.weight, spec.default_subtopic, spec.type ?? 'newslike');
}

// --------------------------------------------------------------------------- registry
export const FETCHERS = { rss: fetchRss };
export const API_FETCHERS = {};
export function registerApiFetcher(name, fn) { API_FETCHERS[name] = fn; }

export function* iterFeedSpecs(feeds) {
  for (const group of Object.values(feeds ?? {})) {
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      for (const specs of Object.values(group)) yield *specs;
    } else if (Array.isArray(group)) {
      yield *group;
    }
  }
}

export const API_PROVIDER_NAMES = {
  openalex: 'OpenAlex',
  semanticscholar: 'Semantic Scholar',
  ieeexplore: 'IEEE Xplore',
};

export function apiProviderName(key) {
  return API_PROVIDER_NAMES[key] ?? key;
}

function apiFetcherKey(spec) {
  return spec.fetcher || String(spec.source ?? '').toLowerCase().replace(/\s+/g, '_');
}

/**
 * Summarize the publication ages of the items an API feed actually returned.
 * Items with no usable published date are counted separately: the brief falls
 * back to first_seen for those, so they would otherwise look artificially fresh.
 */
export function summarizeItemAges(items, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ages = [];
  let undated = 0;

  for (const item of items ?? []) {
    if (!item?.published) { undated += 1; continue; }
    const published = item.published instanceof Date
      ? item.published
      : new Date(item.published);
    if (Number.isNaN(published.getTime())) { undated += 1; continue; }
    ages.push(Math.max(0, (nowMs - published.getTime()) / 86400000));
  }

  ages.sort((a, b) => a - b);
  const at = (fraction) => ages.length
    ? ages[Math.min(ages.length - 1, Math.floor(fraction * ages.length))]
    : null;
  const round = (value) => (value == null ? null : Math.round(value * 10) / 10);
  const buckets = {
    d0_7: ages.filter((age) => age <= 7).length,
    d7_30: ages.filter((age) => age > 7 && age <= 30).length,
    d30_90: ages.filter((age) => age > 30 && age <= 90).length,
    d90_plus: ages.filter((age) => age > 90).length,
  };

  return {
    dated: ages.length,
    undated,
    min: round(ages[0] ?? null),
    median: round(at(0.5)),
    p90: round(at(0.9)),
    max: round(ages[ages.length - 1] ?? null),
    buckets,
  };
}

/**
 * Fetch every configured API feed, keeping one result per spec.
 *
 * Unlike refreshApiFeeds(), this does not throw on individual feed failures and
 * keeps the item count/error for diagnostics (the statistics API-health card).
 * @returns {Promise<Array<{
 *   name: string, fetcher: string, provider: string,
 *   ok: boolean, skipped: boolean, itemCount: number,
 *   items: Array, error: string|null, errorName: string|null, envVar: string|null, ms: number
 * }>>}
 */
export async function fetchApiFeedsDetailed(cfg, src, {
  now = new Date(),
  env = process.env,
  noCache = false,
  makeFetcher = () => new Fetcher(cfg?.fetch ?? {}, { noCache }),
} = {}) {
  const f = makeFetcher();
  const results = [];

  for (const spec of iterFeedSpecs(src?.feeds ?? {})) {
    if (spec.kind !== 'api') continue;
    const key = apiFetcherKey(spec);
    const result = {
      name: spec.name ?? key,
      fetcher: key,
      provider: apiProviderName(key),
      ok: false,
      skipped: false,
      itemCount: 0,
      items: [],
      age: null,
      error: null,
      errorName: null,
      envVar: spec.api_key_env ?? null,
      ms: 0,
    };

    if (spec.api_key_env && !env[spec.api_key_env]) {
      result.skipped = true;
      result.error = 'missing ' + spec.api_key_env;
      results.push(result);
      continue;
    }

    const fn = API_FETCHERS[key];
    if (!fn) {
      result.skipped = true;
      result.error = 'no fetcher registered for ' + key;
      results.push(result);
      continue;
    }

    const t0 = Date.now();
    try {
      const got = await fn(f, spec, { now });
      for (const it of got) it.feed = spec.name;
      result.ok = true;
      result.itemCount = got.length;
      result.items = got;
      result.age = summarizeItemAges(got, now);
    } catch (e) {
      result.error = e?.message ?? String(e);
      result.errorName = e?.constructor?.name ?? 'Error';
    } finally {
      result.ms = Date.now() - t0;
    }
    results.push(result);
  }

  return results;
}

export async function refreshApiFeeds(cfg, src, { onResults, ...options } = {}) {
  const results = await fetchApiFeedsDetailed(cfg, src, options);
  if (typeof onResults === 'function') {
    try { await onResults(results); }
    catch (e) { console.warn(`could not record API feed results: ${e.message}`); }
  }

  const items = [];
  for (const r of results) {
    if (r.skipped) {
      console.log('API skipped ' + r.name + ': '
        + (r.envVar ? 'set ' + r.envVar + ' to enable' : r.error));
    } else if (r.ok) {
      items.push(...r.items);
      console.log(`API refreshed ${r.name}: ${r.itemCount} items`);
    } else {
      console.warn(`API source ${r.name} failed (${r.errorName}: ${r.error})`);
    }
  }
  console.log('API background refresh complete');
  return items;
}

export async function fetchAll(cfg, src) {
  const f = new Fetcher(cfg.fetch);
  const items = [];
  const stats = {};

  async function run(label, fn, spec) {
    try {
      const got = await fn(f, spec);
      // Tag every item with its feed spec name: OpenAlex reports the venue as `source`,
      // so this is the only handle back to the sources.json entry (and its cadence_days).
      for (const it of got) it.feed = spec.name;
      return [label, got, null];
    } catch (e) {
      return [label, [], `${e.constructor.name}: ${e.message}`];
    }
  }

  const jobs = [];
  for (const spec of iterFeedSpecs(src.feeds ?? {})) {
    const kind = spec.kind ?? 'rss';
    if (kind === 'api') continue;
    const fn = FETCHERS[kind];
    if (!fn) {
      console.warn(`unknown feed kind ${kind} for ${spec.name ?? '?'}; skipping`);
      continue;
    }
    jobs.push(run(spec.name, fn, spec));
  }
  const results = await Promise.all(jobs);
  for (const [label, got, err] of results) {
    if (err) console.warn(`source ${label} failed (${err})`);
    stats[label] = got.length;
    items.push(...got);
  }
  console.log('fetched: ' + Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(', '));
  return items;
}
