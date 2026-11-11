// JS port of brief.py's render_* functions. Templates are re-read on every request, so editing a
// template or rebuilding tailwind.css takes effect on reload (this replaces the old --re-render).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const REPO_URL = 'https://github.com/Lawrence-lugs/daily_brief';
// Read once at startup. Null when git is unavailable (e.g. packaged Electron build), which hides the chip.
const GIT_INFO = (() => {
  try {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const hash = git('rev-parse', 'HEAD');
    const remote = git('branch', '-r', '--contains', 'HEAD').length > 0;
    return { short: hash.slice(0, 7), hash, remote, dirty: git('status', '--porcelain').length > 0 };
  } catch { return null; }
})();
const commitHtml = () => {
  if (!GIT_INFO) return '';
  const { short, hash, remote, dirty } = GIT_INFO;
  if (dirty) return `<span class="sb-chip sb-chip--dirty" title="Local changes on ${short}, not on GitHub">${short} detached</span>`;
  if (!remote) return `<span class="sb-chip" title="Commit not pushed to GitHub">${short}</span>`;
  return `<a class="sb-chip" href="${REPO_URL}/commit/${hash}" target="_blank" rel="noopener" title="View commit on GitHub">${short}</a>`;
};

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
    // Desks with no items are not shown and do not occupy a column.
    const nonEmptyDesks = Object.fromEntries(
      Object.entries(allDesks).filter(([, d]) => Array.isArray(d.stories) && d.stories.length > 0)
    );
    const meta = brief?.meta ?? {};
    const storyState = {};
    for (const d of Object.values(nonEmptyDesks)) {
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

    // Render every non-empty desk section generically (Phase 6: N-desk support). Desks with no
    // stories are dropped entirely so they don't show up or occupy a column.
    const deskSections = Object.entries(nonEmptyDesks).map(([key, d]) => {
      const storiesHtml = raw(renderDesk(d.stories ?? []));
      return fill(tpl('desk-section.html'), {
        key,
        title: d.title ?? key,
        deck: raw(d.deck ?? ''),
        stories: storiesHtml,
      });
    }).join('');

    const deskCount = Object.keys(nonEmptyDesks).length;
    let deskGridStyle = '';
    if (deskCount >= 2) {
      // Decision 5: W2 = min width of 2-column format (current md breakpoint = 768px).
      // C columns at width >= ceil((C/2) * W2); 1 column below W2. Cap at 3 columns.
      // Fill the last row: with N desks at C columns, r = N mod C desks sit in the short last row.
      // Use T = lcm(C, r) tracks; normal desks span T/C and last-row desks span T/r, so every row fills the width.
      const W2 = 768;
      const columns = Math.min(deskCount, 3);
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      // 1px divider line only between desks in the same row (light/dark theme-aware).
      // A section is the rightmost of its row when its index is a multiple of the column count,
      // and the last child never gets a divider. Single-column (below W2) gets no divider.
      const divider = (cols, media) => `@media ${media} {`
        + ` [data-desks] > section:not(:last-child):not(:nth-child(${cols}n)) { border-right: 1px solid var(--color-stone-300); }`
        + ` html.dark [data-desks] > section:not(:last-child):not(:nth-child(${cols}n)) { border-right-color: var(--color-stone-700); } }`;
      const rules = [`[data-desks] { display: grid; gap: 1rem; }`];
      for (let c = 2; c <= columns; c++) {
        const min = Math.ceil((c / 2) * W2);
        const max = c < columns ? Math.ceil(((c + 1) / 2) * W2) - 1 : null;
        const media = `(min-width: ${min}px)` + (max !== null ? ` and (max-width: ${max}px)` : '');
        const r = deskCount % c;
        const tracks = r ? (c * r) / gcd(c, r) : c;
        rules.push(`@media ${media} { [data-desks] { grid-template-columns: repeat(${tracks}, 1fr); } }`);
        rules.push(`@media ${media} { [data-desks] > section { grid-column: span ${tracks / c}; } }`);
        if (r) rules.push(`@media ${media} { [data-desks] > section:nth-last-child(-n+${r}) { grid-column: span ${tracks / r}; } }`);
        rules.push(divider(c, media));
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
      repo_url: REPO_URL,
      commit_html: raw(commitHtml()),
    });
  }

  return { page, renderStory };
}
