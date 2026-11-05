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
