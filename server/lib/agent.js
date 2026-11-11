/** Agent subsystem (port of src/agent.js).

OpenRouter chat loop with model fallbacks and retries, JSON extraction with
malformed-response salvage (extractJson, salvageItems), the editor
user-message builder (buildUserMessage, buildUserMessageMulti) and the editor
result applier (applyEditorMulti, applyEditor).
*/
import { readFileSync, appendFileSync, existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const KEY_FILE = path.join(homedir(), '.config', 'openrouter.key');

// Set by brief.js to outDir / "agent_responses.jsonl" so every agent JSON
// response (success or failure) is persisted beside the output HTML for
// debugging model JSON errors.
let DEBUG_LOG = null;

function debugLog(entry) {
  const logPath = DEBUG_LOG;
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // never let debug logging break a generation
  }
}

export class LLMUnavailable extends Error {}

export class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.requests = 0;
    this.models = [];
    this.key = this._loadKey();
  }

  _loadKey() {
    const k = process.env.OPENROUTER_API_KEY || (
      existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : ''
    );
    if (!k) throw new LLMUnavailable(`no API key (env OPENROUTER_API_KEY or ${KEY_FILE})`);
    return k;
  }

  async _http(url, body = null, timeout = 30) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          'X-Title': 'obsidian-daily-brief',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = {}; }
      return [json, res.headers, raw];
    } finally {
      clearTimeout(timer);
    }
  }

  async remainingDaily() {
    try {
      const [d] = await this._http('https://openrouter.ai/api/v1/key', null, 30);
      return d.data?.free_model_daily_requests?.remaining ?? null;
    } catch (e) {
      console.warn(`could not read free-request quota (${e.constructor.name}); continuing`);
      return null;
    }
  }

  async chat(system, user) {
    const c = this.cfg;
    const models = (c.models || [c.model]).filter(Boolean);
    if (!models.length) throw new LLMUnavailable('no models configured');
    let last = 'unknown';
    for (const model of models) {
      for (let attempt = 0; attempt <= c.retries; attempt++) {
        if (this.requests >= c.max_requests_per_run) {
          throw new LLMUnavailable(`per-run request cap reached (${last})`);
        }
        this.requests += 1;
        try {
          const messages = [
            { role: 'system', content: system },
            { role: 'user', content: user + (attempt > 0
              ? '\n\nIMPORTANT: your previous reply was not valid JSON. Reply with ONE valid JSON object only, no prose. Keep each blurb to two short sentences.'
              : '') },
          ];
          const body = {
            model,
            temperature: c.temperature,
            max_tokens: c.max_tokens,
            response_format: { type: 'json_object' },
            reasoning: { effort: c.effort },
            messages,
          };
          const [resp, , raw] = await this._http(
            'https://openrouter.ai/api/v1/chat/completions', body, c.timeout_s,
          );
          const choices = resp.choices || [];
          if (!choices.length) {
            debugLog({ event: 'response_no_choices', model, attempt: attempt + 1, response: resp });
            throw new Error(`response has no choices (response_id=${resp.id ?? '?'}, model=${resp.model ?? model}, keys=${Object.keys(resp).sort()})`);
          }
          const choice = choices[0];
          const message = choice.message || {};
          const content = (message.content || '').trim();
          if (!content) {
            debugLog({ event: 'response_empty_content', model, attempt: attempt + 1, response: resp });
            throw new Error(`empty content (response_id=${resp.id ?? '?'}, model=${resp.model ?? model}, finish_reason=${choice.finish_reason}, refusal=${message.refusal}, usage=${JSON.stringify(resp.usage)})`);
          }
          const parsed = extractJson(content);
          if (parsed._salvaged) {
            console.warn(`model ${resp.model ?? model} returned malformed JSON; recovered ${parsed.items.length} items`);
          }
          debugLog({ event: 'response_ok', model: resp.model ?? model, attempt: attempt + 1, response: resp, raw_content: content });
          this.models.push(resp.model ?? model);
          return parsed;
        } catch (e) {
          let detail = '';
          if (e.name === 'HTTPError') { detail = e.detail ?? ''; }
          debugLog({ event: e.name === 'HTTPError' ? 'http_error' : 'request_error', model, attempt: attempt + 1, error: `${e.constructor.name}: ${e}` });
          last = `${e.constructor.name}: ${e.message}` + (detail ? `: ${detail}` : '');
          console.warn(`model ${model} attempt ${attempt + 1}/${c.retries + 1} failed: ${last}`);
          if (e.name === 'HTTPError' && e.code === 401) {
            throw new LLMUnavailable(last);
          }
          if (e.name === 'HTTPError' && [400, 402, 403, 404].includes(e.code)) {
            break;
          }
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    debugLog({ event: 'all_models_failed', models, last_error: last });
    throw new LLMUnavailable(`all configured models failed (${last})`);
  }
}

function balancedObjects(text) {
  const results = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; }
    else if (ch === '{') { stack.push(i); }
    else if (ch === '}' && stack.length) { results.push(text.slice(stack.pop(), i + 1)); }
  }
  return results;
}

function salvageItems(text) {
  const items = [];
  for (const chunk of balancedObjects(text)) {
    try {
      const d = JSON.parse(chunk);
      if (typeof d === 'object' && d !== null && 'id' in d && ('headline' in d || d.keep === false)) {
        items.push(d);
      }
    } catch { continue; }
  }
  if (!items.length) return null;
  const m = text.match(/"deck"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const lead = text.match(/"lead_id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { deck: m ? m[1] : '', lead_id: lead ? lead[1] : '', items, _salvaged: true };
}

export function extractJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  let i, j;
  try { i = cleaned.indexOf('{'); j = cleaned.lastIndexOf('}'); } catch { i = -1; j = -1; }
  if (i >= 0 && j > i) {
    try { return JSON.parse(cleaned.slice(i, j + 1)); } catch {}
  }
  const s = salvageItems(cleaned);
  if (s) return s;
  throw new Error('could not extract JSON from model response');
}

function clip(v, n) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

export function buildUserMessage(deskTitle, n, cands, today, keepCap = null) {
  const slim = cands.map(c => ({
    id: c.id, kind: c.kind, subtopic: c.subtopic, source: c.source,
    source_type: c.source_type ?? 'commentary',
    age_days: Math.round(c.age_days * 10) / 10,
    title: String(c.title ?? '').slice(0, 220),
    snippet: String(c.snippet ?? '').slice(0, 600),
  }));
  const cap = keepCap ?? n;
  return `Today is ${today}. Desk: ${deskTitle}.\n` +
    `Keep at least ${cap} of the candidates below, best first, and write them up per the schema. ` +
    'Include at least one newslike candidate when one is available. ' +
    `Candidates are listed in the editor's suggested order but you may reorder by importance.\n\n` +
    `CANDIDATES:\n${JSON.stringify(slim, null, 1)}`;
}

export function buildUserMessageMulti(desks, n, candsByDesk, today, keepCap = null) {
  const cap = keepCap ?? n;
  const sections = [];
  for (const d of desks) {
    const deskKey = d.key;
    const deskTitle = d.title;
    const deskDesc = d.description ? ` — ${d.description}` : '';
    const cands = candsByDesk[deskKey] || [];
    const slim = cands.map(c => ({
      id: c.id, desk: deskKey, kind: c.kind, subtopic: c.subtopic,
      source: c.source, source_type: c.source_type ?? 'commentary',
      age_days: Math.round(c.age_days * 10) / 10,
      title: String(c.title ?? '').slice(0, 220),
      snippet: String(c.snippet ?? '').slice(0, 600),
    }));
    sections.push(`DESK: ${deskKey} — ${deskTitle}${deskDesc}\n${JSON.stringify(slim, null, 1)}`);
  }
  return `Today is ${today}. Desks: ${desks.map(d => `${d.key} (${d.title})${d.description ? `: ${d.description}` : ''}`).join(', ')}.\n` +
    `Keep at least ${cap} items for EACH desk below, best first per desk, and write them up per the schema. ` +
    "Include at least one newslike candidate when one is available on that desk. " +
    "Candidates are listed in the editor's suggested order but you may reorder by importance. " +
    'Never change an item\'s desk.\n\n' + sections.join('\n\n');
}

export function applyEditorMulti(selectedByDesk, result, n) {
  const byIdAll = {};
  for (const items of Object.values(selectedByDesk)) {
    for (const c of items) byIdAll[c.id] = c;
  }
  const decks = (result && typeof result === 'object') ? result.decks : {};
  const items = (result && typeof result === 'object' && Array.isArray(result.items)) ? result.items : [];
  const perDesk = {};
  const rejected = {};
  const seen = new Set();
  for (const desk of Object.keys(selectedByDesk)) {
    perDesk[desk] = [];
    rejected[desk] = [];
  }
  for (const e of items) {
    if (typeof e !== 'object' || e === null) continue;
    const iid = String(e.id ?? '');
    if (!iid || seen.has(iid)) continue;
    seen.add(iid);
    let desk = e.desk;
    if (!(desk in selectedByDesk)) {
      const c = byIdAll[iid];
      desk = (c && typeof c === 'object') ? c.desk : null;
    }
    if (!(desk in selectedByDesk)) continue;
    const c = byIdAll[iid];
    if (!c) continue;
    if (e.keep === false) { rejected[desk].push(iid); continue; }
    const head = clip(e.headline, 140);
    const blurb = clip(e.blurb, 650);
    if (!head || !blurb) continue;
    let sig = 3;
    try { sig = Math.max(1, Math.min(5, Number(e.significance ?? 3))); } catch { sig = 3; }
    const tags = [];
    for (const t of (e.tags ?? [])) {
      if (typeof t === 'string' && t.trim()) tags.push(clip(t, 24));
      if (tags.length >= 3) break;
    }
    perDesk[desk].push({ ...c, headline: head, blurb, why_care: clip(e.why_care, 170), tags, significance: sig, summarized: true });
  }
  const out = {};
  for (const [desk, cands] of Object.entries(selectedByDesk)) {
    const stories = perDesk[desk];
    if (stories.length < n) {
      const have = new Set(stories.map(s => s.id));
      const rej = new Set(rejected[desk]);
      for (const c of cands) {
        if (stories.length >= n) break;
        if (have.has(c.id) || rej.has(c.id)) continue;
        stories.push({ ...c, headline: c.title.slice(0, 140),
          blurb: (c.snippet ?? '').slice(0, 320) || 'No summary available.',
          why_care: '', tags: [c.subtopic], significance: 1, summarized: false });
      }
    }
    stories.splice(n);
    const deckEntry = (typeof decks === 'object' && decks !== null) ? decks[desk] : undefined;
    const lead = (deckEntry && typeof deckEntry === 'object') ? String(deckEntry.lead_id ?? '') : '';
    if (lead && stories.length) {
      stories.sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : 0));
      if (stories[0].id !== lead) stories.sort((a, b) => b.significance - a.significance);
    }
    const deck = clip((deckEntry && typeof deckEntry === 'object') ? deckEntry.deck ?? '' : '', 220);
    out[desk] = [stories, rejected[desk], deck];
  }
  return out;
}

export function applyEditor(cands, result, n) {
  const byId = {};
  for (const c of cands) byId[c.id] = c;
  const stories = [];
  const rejected = [];
  let deck = '';
  const seen = new Set();
  if (result) {
    deck = clip(result.deck, 220);
    const items = Array.isArray(result.items) ? result.items : [];
    for (const e of items) {
      if (typeof e !== 'object' || e === null) continue;
      const iid = String(e.id ?? '');
      const c = byId[iid];
      if (!c || seen.has(iid)) continue;
      seen.add(iid);
      if (e.keep === false) { rejected.push(iid); continue; }
      const head = clip(e.headline, 140);
      const blurb = clip(e.blurb, 650);
      if (!head || !blurb) continue;
      let sig = 3;
      try { sig = Math.max(1, Math.min(5, Number(e.significance ?? 3))); } catch { sig = 3; }
      const tags = [];
      for (const t of (e.tags ?? [])) {
        if (typeof t === 'string' && t.trim()) tags.push(clip(t, 24));
        if (tags.length >= 3) break;
      }
      stories.push({ ...c, headline: head, blurb, why_care: clip(e.why_care, 170), tags, significance: sig, summarized: true });
    }
  }
  if (stories.length < n) {
    const have = new Set(stories.map(s => s.id));
    const rej = new Set(rejected);
    for (const c of cands) {
      if (stories.length >= n) break;
      if (have.has(c.id) || rej.has(c.id)) continue;
      stories.push({ ...c, headline: c.title.slice(0, 140),
        blurb: (c.snippet ?? '').slice(0, 320) || 'No summary available.',
        why_care: '', tags: [c.subtopic], significance: 1, summarized: false });
    }
  }
  stories.splice(n);
  if (result && stories.length) {
    const lead = String(result.lead_id ?? '');
    stories.sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : 0));
    if (stories[0].id !== lead) stories.sort((a, b) => b.significance - a.significance);
  }
  return [stories, rejected, deck];
}

function existsSync(p) {
  try { readFileSync(p); return true; } catch { return false; }
}

export function setDebugLog(filePath) { DEBUG_LOG = filePath; }
