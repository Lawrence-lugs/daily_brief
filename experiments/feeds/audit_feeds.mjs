/**
 * @fileoverview Audit every RSS feed in user/defaults/sources.json.
 *
 * Scope (per AGENTS.md): experiment-specific code lives under experiments/feeds/.
 * This is the ONLY folder touched by this script. It reads (never writes)
 * user/defaults/sources.json and user/defaults/config.json.
 *
 * Purpose: fetch each RSS source with the app's real User-Agent (read from
 * config.json) and print a summary table of which ones succeed vs. are blocked,
 * plus item counts. Mirrors the findings table from feeds.mjs but is driven
 * entirely by config so it stays in sync as sources are added/removed.
 *
 * Run: node experiments/feeds/audit_feeds.mjs
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/** Resolve the app's real User-Agent from config.json. */
async function loadUserAgent() {
  try {
    const cfg = JSON.parse(await readFile(join(ROOT, 'user', 'defaults', 'config.json'), 'utf8'));
    return String(cfg?.fetch?.user_agent ?? 'DailyBrief/1.0');
  } catch {
    return 'DailyBrief/1.0';
  }
}

/** Load all RSS feed specs from sources.json. */
async function loadRssSpecs() {
  const txt = await readFile(join(ROOT, 'user', 'defaults', 'sources.json'), 'utf8');
  const data = JSON.parse(txt);
  const specs = [];

  function collectList(list) {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (s && s.kind === 'rss' && s.url) specs.push(s);
    }
  }

  for (const group of Object.values(data.feeds ?? {})) {
    if (!group || typeof group !== 'object') continue;
    if (Array.isArray(group)) {
      // "rss": [...] — feeds listed directly
      collectList(group);
    } else {
      // "api": { "<fetcher>": [...] } — nested under fetcher keys
      for (const list of Object.values(group)) collectList(list);
    }
  }
  return specs;
}

const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*';
const TIMEOUT_MS = 15000;

function stripHtml(s) {
  if (!s) return '';
  let t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function parseDate(s) {
  if (!s) return null;
  let d = new Date(String(s).trim());
  if (isNaN(d.getTime())) {
    try { d = new Date(String(s).replace('Z', '+00:00')); } catch { return null; }
  }
  return isNaN(d.getTime()) ? null : d;
}

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

async function fetchFeed(url, ua) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res, body, err;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': ACCEPT },
      signal: controller.signal,
    });
    body = await res.text();
  } catch (e) {
    err = e?.message ?? String(e);
  } finally {
    clearTimeout(timer);
  }
  return { res, body, err };
}

async function run() {
  const ua = await loadUserAgent();
  const specs = await loadRssSpecs();
  const results = [];

  console.log(`User-Agent: ${ua}\n`);
  console.log(`Auditing ${specs.length} RSS feed(s) from user/defaults/sources.json\n`);

  for (const spec of specs) {
    const result = {
      name: spec.name,
      url: spec.url,
      type: spec.type,
      default_subtopic: spec.default_subtopic,
      status: null,
      ok: false,
      feedValid: false,
      itemCount: 0,
      blocked: false,
      blockReason: null,
      error: null,
    };

    const { res, body, err } = await fetchFeed(spec.url, ua);

    if (err) {
      result.error = err;
      if (err.includes('Abort')) {
        result.blocked = true;
        result.blockReason = 'timeout';
      }
      results.push(result);
      continue;
    }

    result.status = res.status;
    result.ok = res.ok;

    if (!res.ok) {
      result.error = `HTTP ${res.status} ${res.statusText}`;
      const reason = classifyBlock(res.status, body ?? '');
      if (reason) { result.blocked = true; result.blockReason = reason; }
      results.push(result);
      continue;
    }

    const hasRss = /<\s*rss\b/i.test(body ?? '');
    const hasFeed = /<\s*feed\b/i.test(body ?? '');
    const hasRdf = /<\s*rdf\b/i.test(body ?? '');
    result.feedValid = hasRss || hasFeed || hasRdf;

    if (result.feedValid) {
      result.itemCount = extractItems(body ?? '', spec.name).length;
    } else {
      result.error = 'HTTP 200 but not a recognizable RSS/Atom feed';
    }

    results.push(result);
  }

  printTable(results);
  printVerdict(results);
}

function printTable(results) {
  const pad = (s, n) => String(s).padEnd(n, ' ');
  const ok = results.filter(r => r.ok && r.feedValid);
  const blocked = results.filter(r => r.blocked);
  const failed = results.filter(r => !r.ok && !r.blocked);

  console.log(`${pad('STATUS', 8)} ${pad('ITEMS', 6)} ${pad('BLOCKED', 14)} SOURCE`);
  console.log('-'.repeat(100));
  for (const r of results) {
    const flag = r.ok && r.feedValid ? '✅ OK  ' : r.blocked ? '🚫 BLOCK' : '❌ ERR ';
    const items = r.ok && r.feedValid ? String(r.itemCount) : '0';
    const reason = r.blockReason ?? '-';
    console.log(`${flag} ${pad(r.status ?? 'n/a', 8)} ${pad(items, 6)} ${pad(reason, 14)} ${r.name}`);
  }
  console.log(`\nTotals: ${results.length} feeds | OK: ${ok.length} | Blocked: ${blocked.length} | Failed: ${failed.length}`);
}

function printVerdict(results) {
  const working = results.filter(r => r.ok && r.feedValid);
  console.log('\n--- Working feeds ---');
  if (working.length === 0) {
    console.log('(none)');
  } else {
    for (const r of working) {
      console.log(`  ✅ ${r.name} — ${r.itemCount} items — ${r.url}`);
    }
  }
  console.log('\n--- Blocked / failed feeds ---');
  const bad = results.filter(r => !r.ok || !r.feedValid);
  if (bad.length === 0) {
    console.log('(none)');
  } else {
    for (const r of bad) {
      const detail = r.blocked ? `BLOCKED (${r.blockReason})` : `ERROR: ${r.error}`;
      console.log(`  🚫 ${r.name} — HTTP ${r.status ?? 'n/a'} — ${detail} — ${r.url}`);
    }
  }
}

run().catch((e) => { console.error('Audit failed:', e); process.exit(1); });
