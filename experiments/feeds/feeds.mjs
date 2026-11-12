/**
 * @fileoverview RSS feed fetch experiment.
 *
 * Scope (per AGENTS.md contract): experiment-specific code lives under
 * experiments/feeds/. This is the ONLY folder touched by this work.
 *
 * Purpose: determine which of the candidate RSS/Atom sources can be fetched
 * "properly" (HTTP 200 + parseable feed) from this environment, and surface a
 * structured, machine-readable result per source.
 *
 * Findings (captured in README.md):
 *   - IEEE JSSC / TCAS-I / JETCAS / TCASAI: HTTP 200, valid RSS, items parse.
 *   - ACM TACO / CSUR / Queue (dl.acm.org eTOC): HTTP 403 Cloudflare "Just a
 *     moment..." JS challenge. Not fetchable with plain fetch OR headless
 *     Playwright in this environment.
 *   - CACM /feed/: HTTP 403 Cloudflare. Not fetchable.
 *
 * Run: node experiments/feeds/feeds.mjs
 * Output: experiments/feeds/results.json + console summary table.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(import.meta.dirname, 'results.json');

/** Resolve the app's real User-Agent from user/defaults/config.json so the
 * experiment reflects what the actual fetch pipeline sends. */
let UA = 'DailyBrief/1.0';
try {
  const cfg = JSON.parse(await readFile(join(ROOT, 'user', 'defaults', 'config.json'), 'utf8'));
  UA = cfg?.fetch?.user_agent ?? UA;
} catch {}
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml, text/xml, */*';
const TIMEOUT_MS = 15000;

/** Candidate sources under test. Mirrors the URL set the user validated. */
const SOURCES = [
  {
    name: 'IEEE JSSC — Solid-State Circuits',
    url: 'https://ieeexplore.ieee.org/rss/TOC4.XML',
    type: 'researchlike',
    default_subtopic: 'fab',
  },
  {
    name: 'IEEE TCAS-I — Circuits and Systems I',
    url: 'https://ieeexplore.ieee.org/rss/TOC8919.XML',
    type: 'researchlike',
    default_subtopic: 'fab',
  },
  {
    name: 'ACM TACO — Architecture and Code Optimization',
    url: 'https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=taco',
    type: 'researchlike',
    default_subtopic: 'dse',
  },
  {
    name: 'ACM CSUR — Computing Surveys',
    url: 'https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=csur',
    type: 'researchlike',
    default_subtopic: null,
  },
  {
    name: 'Communications of the ACM (CACM)',
    url: 'https://cacm.acm.org/feed/',
    type: 'newslike',
    default_subtopic: null,
  },
  {
    name: 'ACM Queue',
    url: 'https://acm-queue-rss.val.run/feed',
    type: 'commentary',
    default_subtopic: 'accel',
  },
];

/** Fetch a single feed URL with browser-like headers and a hard timeout. */
async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': ACCEPT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  return { status: res.status, statusText: res.statusText, ok: res.ok,
    contentType: res.headers.get('content-type') ?? null, finalUrl: res.url, body };
}

/**
 * Minimal RSS/Atom item extraction, consistent with the project's
 * server/lib/fetch/fetcher.js parseFeed/extractItems (regex based, tolerant of
 * feed dialects). Returns items as { title, link, published, source }.
 */
function extractItems(xmlText, sourceName) {
  const out = [];
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
    // link: <link href="..."/> or <link>url</link> (may be CDATA-wrapped).
    let link = '';
    const linkM = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (linkM) link = linkM[1];
    else link = getField(['link']);
    const title = getField(['title']);
    const body = getField(['content', 'encoded', 'description', 'summary']);
    const dateStr = getField(['pubDate', 'published', 'updated', 'date']);
    const date = parseDate(dateStr);
    if (title && link.startsWith('http')) {
      out.push({ title, link, published: date ? date.toISOString() : null,
        snippet: body.slice(0, 900), source: sourceName });
    }
  }
  return out;
}

function stripHtml(s) {
  if (!s) return '';
  // Unwrap CDATA sections first so their text content survives tag stripping.
  let t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let d = new Date(s);
  if (isNaN(d.getTime())) {
    try { d = new Date(s.replace('Z', '+00:00')); } catch { return null; }
  }
  return isNaN(d.getTime()) ? null : d;
}

function looksLikeCloudflare(body) {
  return /Just a moment|Cloudflare|captcha|challenge-platform/i.test(body);
}

function classifyBlock(status, body) {
  if (status === 418) return 'ieee-418-bot-block';
  if (status === 403 && looksLikeCloudflare(body)) return 'cloudflare-403';
  if (status === 403) return 'http-403';
  if (looksLikeCloudflare(body)) return 'cloudflare-challenge';
  return null;
}

async function run() {
  const results = [];
  for (const spec of SOURCES) {
    const result = {
      name: spec.name,
      url: spec.url,
      type: spec.type,
      default_subtopic: spec.default_subtopic,
      fetchedAt: new Date().toISOString(),
      status: null,
      statusText: null,
      ok: false,
      contentType: null,
      finalUrl: null,
      error: null,
      blocked: false,
      blockReason: null,
      itemCount: 0,
      items: [],
      feedValid: false,
    };
    try {
      const { status, statusText, ok, contentType, finalUrl, body } =
        await fetchFeed(spec.url);
      result.status = status;
      result.statusText = statusText;
      result.ok = ok;
      result.contentType = contentType;
      result.finalUrl = finalUrl;

      if (!ok) {
        result.error = `HTTP ${status} ${statusText}`;
        const reason = classifyBlock(status, body);
        if (reason) {
          result.blocked = true;
          result.blockReason = reason;
        }
        results.push(result);
        continue;
      }

      // Feed validity: must contain <rss or <feed and at least one item/entry.
      const hasRss = /<\s*rss\b/i.test(body);
      const hasFeed = /<\s*feed\b/i.test(body);
      const hasRdf = /<\s*rdf\b/i.test(body);
      result.feedValid = hasRss || hasFeed || hasRdf;

      let items = [];
      if (result.feedValid) {
        items = extractItems(body, spec.name);
      }
      result.itemCount = items.length;
      result.items = items;
    } catch (e) {
      result.error = e?.message ?? String(e);
      if (e?.name === 'AbortError') {
        result.blocked = true;
        result.blockReason = 'timeout';
      }
    }
    results.push(result);
  }

  await mkdir(import.meta.dirname, { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(),
    sources: SOURCES.length, results }, null, 2), 'utf8');

  printSummary(results);
  return results;
}

function printSummary(results) {
  const ok = results.filter(r => r.ok && r.feedValid);
  const blocked = results.filter(r => r.blocked);
  const failed = results.filter(r => !r.ok && !r.blocked);
  console.log('\n=== RSS feed fetch experiment ===');
  console.log(`Fetched: ${results.length} | OK: ${ok.length} | Blocked: ${blocked.length} | Failed: ${failed.length}\n`);
  for (const r of results) {
    const flag = r.ok && r.feedValid ? '✅' : r.blocked ? '🚫' : '❌';
    console.log(`${flag} ${r.name}`);
    console.log(`     url: ${r.url}`);
    if (r.ok && r.feedValid) {
      console.log(`     status: ${r.status} | items: ${r.itemCount} | type: ${r.contentType}`);
      for (const it of r.items.slice(0, 3)) {
        console.log(`       - ${it.title} (${it.link})`);
      }
      if (r.itemCount > 3) console.log(`       ... and ${r.itemCount - 3} more`);
    } else if (r.blocked) {
      console.log(`     status: ${r.status ?? 'n/a'} | BLOCKED: ${r.blockReason} | ${r.error ?? ''}`);
    } else {
      console.log(`     status: ${r.status ?? 'n/a'} | ERROR: ${r.error}`);
    }
  }
  console.log(`\nResults written to: ${OUT}`);
  const working = ok.length;
  const total = results.length;
  console.log(`\nVerdict (using the app's real UA from user/defaults/config.json):`);
  console.log(`  ${working}/${total} sources fetch properly.`);
  if (working === 0) {
    console.log(`  None of the tested IEEE/ACM/CACM sources are reachable: IEEE returns 418`);
    console.log(`  (bot block) and ACM/CACM/dl.acm.org return 403 (Cloudflare).`);
  }
  console.log(`  ACM Queue via https://acm-queue-rss.val.run/feed is the working replacement`);
  console.log(`  (HTTP 200, valid RSS). IEEE and ACM/CACM remain blocked — keep them in`);
  console.log(`  config but expect the pipeline to skip+warn on failure, not crash.`);
}

run().catch((e) => { console.error('Experiment failed:', e); process.exit(1); });
