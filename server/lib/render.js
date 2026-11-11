// JS port of brief.py's render_* functions. Templates are re-read on every request, so editing a
// template or rebuilding tailwind.css takes effect on reload (this replaces the old --re-render).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatBackside } from './backside.js';

class Raw { constructor(s) { this.s = s; } }
export const raw = (s) => new Raw(s);

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#x27;'); // same set as python html.escape(quote=True)

/** {{name}} substitution; Raw values pass through, everything else is HTML-escaped. */
export function fill(tpl, vals) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vals[k];
    return v instanceof Raw ? v.s : esc(v ?? '');
  });
}

export function ageLabel(d) {
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 14) return `${Math.floor(d)} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

export const safeUrl = (u) => (/^https?:\/\//.test(u) ? u : '#');

// "2026-10-26" -> "Monday, October 26, 2026" (parsed as a LOCAL date, never via UTC).
export function dateLong(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const localToday = () => {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
};

export function makeRenderer({ templatesDir, cssFile, paperName, basePath = '' }) {
  const tpl = (n) => readFileSync(path.join(templatesDir, n), 'utf8');

  function renderStory(s, lead) {
    const tags = raw(s.tags.map((t) => fill(tpl('tag.html'), { tag: t })).join(''));
    const badge = raw(s.kind === 'archive' ? fill(tpl('badge.html'), { label: 'From the archive' }) : '');
    const why = raw(s.why_care ? fill(tpl('why.html'), { why: s.why_care }) : '');
    const rawNote = raw(s.summarized ? '' : fill(tpl('badge.html'), { label: 'Unedited' }));
    // Cluster medoid info (LR engine only) - SVG icon with tooltip
    let clusterBadge = '';
    if (s.clusterMedoidTitle) {
      clusterBadge = raw(fill(tpl('cluster-badge.html'), { title: s.clusterMedoidTitle }));
    } else {
      clusterBadge = raw('');
    }
    const back = raw(fill(tpl('story-back.html'), formatBackside(s)));
    // AlphaXiv mirror link for arxiv papers: same id, host swapped (arxiv.org -> alphaxiv.org)
    const alphaxiv = /arxiv\.org/i.test(s.url ?? '')
      ? raw(`<a href="${esc(String(s.url).replace('arxiv', 'alphaxiv'))}" target="_blank" rel="noopener noreferrer" class="btn-alpha" title="Read on AlphaXiv" aria-label="AlphaXiv">α</a>`)
      : '';
    return fill(tpl(lead ? 'lead.html' : 'story.html'), {
      id: s.story_id, headline: s.headline, blurb: s.blurb, url: safeUrl(s.url), source: s.source,
      age: ageLabel(s.age_days), tags, badge, why, raw_note: rawNote, cluster_badge: clusterBadge, alphaxiv, back,
    });
  }

  const renderDesk = (stories) => stories.map((s, i) => renderStory(s, i === 0)).join('');

  /**
   * @param {{brief:object|null, desks:object|null, briefs:Array, embed:boolean}} o
   * brief/desks come from queries.getBrief (null => empty page with a Generate button).
   */
  function page({ brief, desks, briefs, embed }) {
    const empty = { title: '', deck: '', stories: [] };
    const allDesks = desks ?? {};
    const meta = brief?.meta ?? {};
    const storyState = {};
    for (const d of Object.values(allDesks)) {
      for (const s of d.stories) storyState[s.story_id] = { liked: !!s.liked, saved: !!s.saved };
    }
    const boot = JSON.stringify({ briefId: brief?.brief_id ?? null, date: brief?.date ?? null, embed, stories: storyState })
      .replace(/</g, '\\u003c');
    const stale = brief && brief.date !== localToday();
    const status = !brief ? 'No brief yet. Click Generate.'
      : stale ? `Latest brief is from ${brief.date} (not today)` : `Brief for ${brief.date}`;
    const options = briefs.map((b) => {
      const t = new Date(b.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const engine = b.engine ? ` [${b.engine}]` : '';
      const sel = brief && b.brief_id === brief.brief_id ? ' selected' : '';
      return `<option value="${b.brief_id}"${sel}>${esc(b.date)} ${t}${engine}</option>`;
    }).join('');
    const footer = brief
      ? `Edited by ${meta.model} (${meta.engine ?? 'keyword'}). ${meta.n_fresh} recent, ${meta.n_archive} from the archive. ` +
        `${meta.n_explore} explore picks (epsilon ${meta.epsilon}). Candidate pool: ${meta.pool} items. Sources: ${meta.sources}.`
      : '';

    // Render every desk section generically (Phase 6: N-desk support). Desks absent from the data
    // still render as empty sections so the page layout stays stable.
    const deskSections = Object.entries(allDesks).map(([key, d]) => {
      const storiesHtml = raw(renderDesk(d.stories ?? []));
      return fill(tpl('desk-section.html'), {
        key,
        title: d.title ?? key,
        deck: raw(d.deck ?? ''),
        stories: storiesHtml,
      });
    }).join('');

    const deskCount = Object.keys(allDesks).length;
    let deskGridStyle = '';
    if (deskCount >= 2) {
      // Decision 5: W2 = min width of 2-column format (current md breakpoint = 768px).
      // N columns at width >= (N/2) * W2; 2 columns at >= W2; 1 column below W2.
      const W2 = 768;
      const nWidth = Math.ceil((deskCount / 2) * W2);
      const rules = [
        `[data-desks] { display: grid; gap: 2rem; }`,
        `@media (min-width: ${W2}px) { [data-desks] { grid-template-columns: repeat(2, 1fr); } }`,
      ];
      if (deskCount > 2) {
        rules.push(`@media (min-width: ${nWidth}px) { [data-desks] { grid-template-columns: repeat(${deskCount}, 1fr); } }`);
      }
      deskGridStyle = rules.join('\n');
    }

    return fill(tpl('page.html'), {
      css: raw(readFileSync(cssFile, 'utf8')),
      desk_grid_style: raw(deskGridStyle),
      desk_sections: raw(deskSections),
      paper_name: paperName,
      date_long: brief ? dateLong(brief.date) : dateLong(localToday()),
      edition: brief ? `No. ${brief.edition}` : '',
      generated: brief ? new Date(brief.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '',
      footer, boot: raw(boot), status, status_class: stale ? 'stale' : '',
      brief_options: raw(options), generate_label: brief ? 'Regenerate' : 'Generate brief',
      basePath,
      hosted: raw(basePath ? '1' : ''),
      gen_hidden: raw(basePath ? ' style="display:none"' : ''),
    });
  }

  return { page, renderStory };
}
