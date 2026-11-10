// Turns the progress.json written by src/progress.py into the `preview` object the client renders.
// Story cards are rendered SERVER-side with the same templates as the real page (renderStory), so the
// preview cards are pixel-identical to the final ones and the client needs no card templating.
import { esc } from './render.js';

/** progress item (raw or edited) -> the story shape renderStory expects. story_id is '' on purpose:
 *  nothing is in the DB yet, so like/save/flip are disabled client-side (.is-preview). */
export function normalizeItem(it) {
  return {
    ...it,
    story_id: '',
    headline: it.headline || it.title || '',
    blurb: it.blurb || it.snippet || 'No summary available.',
    why_care: it.why_care ?? '',
    tags: Array.isArray(it.tags) && it.tags.length ? it.tags : [it.subtopic].filter(Boolean),
    summarized: !!it.summarized,
    kind: it.kind ?? 'fresh',
    age_days: Number(it.age_days) || 0,
    url: it.url ?? '',
    source: it.source ?? '',
  };
}

// Minimal card used only if the real templates throw on an unexpected item.
const fallbackCard = (s) =>
  `<article class="story-card story-fallback"><h3>${esc(s.headline)}</h3><p>${esc(s.blurb)}</p></article>`;

/**
 * @param {object} progress  parsed progress.json (v1)
 * @param {{renderStory:(s:object,lead:boolean)=>string, medoidTitle?:(id:any)=>string|undefined}} ctx
 * @returns {{seq:number,phase:string,engine:string|null,t0:number,
 *            desks:Record<string,{title:string,stage:string,working:boolean,n:number,deck:string,html:string}>}}
 */
export function buildPreview(progress, { renderStory, medoidTitle }) {
  const desks = {};
  for (const [name, d] of Object.entries(progress.desks ?? {})) {
    const items = d.stage === 'pending' ? [] : (d.items ?? []);
    const html = items.map((raw, i) => {
      const s = normalizeItem(raw);
      if (s.medoid_id && medoidTitle) {
        try { s.medoid_title = s.clusterMedoidTitle = medoidTitle(s.medoid_id); } catch { /* optional */ }
      }
      try { return renderStory(s, i === 0); } catch { return fallbackCard(s); }
    }).join('');
    desks[name] = {
      title: d.title ?? name, stage: d.stage ?? 'pending', working: !!d.working,
      n: d.n ?? items.length, deck: d.stage === 'edited' ? (d.deck ?? '') : '', html,
    };
  }
  return { seq: progress.seq, phase: progress.phase, engine: progress.engine ?? null, t0: progress.t0, desks };
}

// --------------------------------------------------------------------------- Progress class (port of src/progress.py)

/** Progress file for the live generation UI (stdlib only, never raises).

brief.js passes `--progress-file <path>`; the server tails it and the client renders it.
The file is rewritten atomically (tmp + rename) after every state change.
Contract (v1):
  {"v":1, "seq":int, "phase":"fetching|selecting|editing|committing|done",
   "engine":"lr|keyword|null", "t0":unix_seconds,
   "desks":{name:{"title":str, "n":int, "stage":"pending|raw|edited", "working":bool,
                 "deck":str, "items":[slim item,...]}}}
*/
import { writeFileSync, renameSync } from 'node:fs';

const ITEM_FIELDS = [
  'id', 'title', 'url', 'source', 'source_type', 'subtopic', 'kind', 'mode', 'age_days',
  'p', 'V', 'cluster', 'core', 'cos_dist', 'cluster_size', 'cluster_pool', 'medoid_id',
  'headline', 'blurb', 'why_care', 'tags', 'significance', 'summarized',
];

function clean(v) {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
  }
  if (Array.isArray(v)) return v.map(clean);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[String(k)] = clean(val);
    return o;
  }
  return String(v);
}

function slimItem(it) {
  const out = {};
  for (const k of ITEM_FIELDS) if (k in it) out[k] = clean(it[k]);
  out.snippet = String(it.snippet ?? '').slice(0, 320);
  return out;
}

export class Progress {
  constructor(pathOrNull, engine = null) {
    this.path = pathOrNull || null;
    this.data = { v: 1, seq: 0, phase: 'fetching', engine, t0: Date.now() / 1000, desks: {} };
    this._flush();
  }

  _flush() {
    if (!this.path) return;
    this.data.seq += 1;
    try {
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data, { allow_nan: false }), 'utf8');
      renameSync(tmp, this.path);
    } catch {
      // progress must never break a generation
    }
  }

  setEngine(engine) { this.data.engine = engine; this._flush(); }
  phase(name) { this.data.phase = name; this._flush(); }
  deskInit(desk, title, n) {
    this.data.desks[desk] = { title, n: Number(n), stage: 'pending', working: false, deck: '', items: [] };
    this._flush();
  }
  deskRaw(desk, items) {
    const d = this.data.desks[desk] || { title: desk, n: items.length, deck: '' };
    d.stage = 'raw';
    d.working = false;
    d.items = items.map(slimItem);
    this.data.desks[desk] = d;
    this._flush();
  }
  deskWorking(desk, flag = true) {
    if (desk in this.data.desks) this.data.desks[desk].working = Boolean(flag);
    this._flush();
  }
  deskEdited(desk, stories, deck = '') {
    const d = this.data.desks[desk] || { title: desk, n: stories.length };
    d.stage = 'edited';
    d.working = false;
    d.deck = String(deck ?? '');
    d.items = stories.map(slimItem);
    this.data.desks[desk] = d;
    this._flush();
  }
}
