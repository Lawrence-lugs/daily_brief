/** Fetching subsystem (port of src/fetch/fetcher.py).

Provides Throttler, Fetcher, stripHtml, parseDate, canonicalUrl, splitAuthors,
makeItem, parseFeed, fetchRss, FETCHERS registry, API_FETCHERS registry,
registerApiFetcher, refreshApiFeeds, fetchAll.
*/
import crypto from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
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
  constructor(cfg) {
    this.cfg = cfg;
    this._throttle = new Throttler(cfg.api_delay_s ?? 0);
    this._cacheDir = cacheDir();
    mkdirSync(this._cacheDir, { recursive: true });
  }
  async get(url, useCache = true, headers = null) {
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    const cacheFile = join(this._cacheDir, hash + '.txt');
    const ttl = (this.cfg.cache_ttl_hours ?? 6) * 3600 * 1000;
    if (useCache && existsSync(cacheFile)) {
      try {
        const st = statSync(cacheFile);
        if (Date.now() - st.mtimeMs < ttl) return readFileSync(cacheFile, 'utf8');
      } catch {}
    }
    const reqHeaders = { 'User-Agent': this.cfg.user_agent, ...(headers || {}) };
    const res = await fetch(url, { headers: reqHeaders });
    const text = await res.text();
    try { writeFileSync(cacheFile, text, 'utf8'); } catch {}
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

export function fetchRss(f, spec) {
  return parseFeed(f.get(spec.url), spec.name, spec.weight, spec.default_subtopic, spec.type ?? 'newslike');
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

export async function refreshApiFeeds(cfg, src) {
  const f = new Fetcher(cfg.fetch);
  const items = [];
  for (const spec of iterFeedSpecs(src.feeds ?? {})) {
    if (spec.kind !== 'api') continue;
    const key = spec.fetcher || String(spec.source ?? '').toLowerCase().replace(/\s+/g, '_');
    const fn = API_FETCHERS[key];
    if (!fn) {
      console.warn(`no api fetcher registered for ${key}; skipping ${spec.name}`);
      continue;
    }
    try {
      const got = await fn(f, spec);
      items.push(...got);
      console.log(`API refreshed ${spec.name}: ${got.length} items`);
    } catch (e) {
      console.warn(`API source ${spec.name} failed (${e.constructor.name}: ${e.message})`);
    }
  }
  console.log('API background refresh complete');
  return items;
}

export async function fetchAll(cfg, src, refreshApi = true) {
  const f = new Fetcher(cfg.fetch);
  const items = [];
  const stats = {};

  async function run(label, fn, spec) {
    try {
      const got = await fn(f, spec);
      return [label, got, null];
    } catch (e) {
      return [label, [], `${e.constructor.name}: ${e.message}`];
    }
  }

  if (refreshApi) {
    const apiCount = [...iterFeedSpecs(src.feeds ?? {})].filter(s => s.kind === 'api').length;
    if (apiCount) {
      console.log(`API background refresh started (${apiCount} queries)`);
      refreshApiFeeds(cfg, src).catch(e => console.warn(`API refresh error: ${e}`));
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
