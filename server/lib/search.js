// server/lib/search.js — FTS5 search + filtered list over `stories` (node:sqlite, no deps).
// Exports: buildMatch(raw), ensureFtsBuilt(db), makeSearch(db) -> { listStories(searchParams), facets() }.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// PHASE-0 DECISION: if `SELECT mode, COUNT(*) FROM stories GROUP BY mode` shows 'reserve' rows that the
// brief page never displays, set this true so the archive lists only stories that were actually shown.
const HIDE_RESERVE = false;

// User-facing column aliases -> FTS5 column names (same names as in schema.sql's stories_fts).
const COLS = {
  title: 'headline', headline: 'headline', blurb: 'blurb', blob: 'blurb', body: 'blurb',
  why: 'why_care', tag: 'tags', tags: 'tags', source: 'source', subtopic: 'subtopic',
};

const quote = (t) => `"${t.replace(/"/g, '""')}"`;
const hasWord = (t) => /[\p{L}\p{N}]/u.test(t);

/**
 * Turn what a human typed into a SAFE FTS5 MATCH expression (or null = "no text filter").
 * Every term is double-quoted, so FTS5 operators/punctuation in user input can never cause a syntax error
 * (AND / OR / NOT / NEAR / ( ) : * - all become plain words).
 * Supported: bare words (implicit AND), "exact phrases", col:word / col:"phrase" (see COLS),
 * and prefix matching on the LAST bare word while the user is still typing (no trailing space).
 */
export function buildMatch(raw) {
  const s = String(raw ?? '').slice(0, 200);
  const typing = !/\s$/.test(s);
  const re = /(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  const toks = [];
  for (let m; (m = re.exec(s)); ) {
    const col = m[1] ? COLS[m[1].toLowerCase()] : undefined;
    const quoted = m[2] !== undefined;
    let text = quoted ? m[2] : m[3];
    if (m[1] && !col) text = `${m[1]} ${text}`; // unknown "prefix:" (e.g. https://x) is just text
    if (!hasWord(text)) continue;
    toks.push({ col, text, quoted });
  }
  if (!toks.length) return null;
  toks.length = Math.min(toks.length, 8);
  return toks.map((t, i) => {
    const star = typing && !t.quoted && i === toks.length - 1 && t.text.length >= 2 ? '*' : '';
    return (t.col ? `${t.col} : ` : '') + quote(t.text) + star;
  }).join(' ');
}

/** One-time (per DB) index population for rows that existed before the FTS table did. Safe to call on every open. */
export function ensureFtsBuilt(db) {
  if (db.prepare("SELECT 1 FROM ranker_state WHERE key = 'fts_v1'").get()) return false;
  db.exec("INSERT INTO stories_fts(stories_fts) VALUES('rebuild')");
  db.prepare("INSERT OR REPLACE INTO ranker_state(key, value, updated_at) VALUES('fts_v1', '1', ?)")
    .run(new Date().toISOString());
  return true;
}

// `stories` has one row per slot per brief and briefs are append-only, so the same item can appear many times.
// Keep only the LAST row per (date, item_id) — the same rule as the training_examples view.
const DEDUPE = `s.story_id = (SELECT MAX(s2.story_id) FROM stories s2 JOIN briefs b2 ON b2.brief_id = s2.brief_id
                              WHERE b2.date = b.date AND s2.item_id = s.item_id)`;

const MARKS = { liked: 's.liked = 1', saved: 's.saved = 1', any: '(s.liked = 1 OR s.saved = 1)' };
// bm25 weights follow the FTS column order: headline, blurb, why_care, tags, source, subtopic
const SORTS = {
  date_desc: 'b.date DESC, s.story_id DESC',
  date_asc: 'b.date ASC, s.story_id ASC',
  rank: 'bm25(stories_fts, 10, 4, 2, 3, 1, 1), b.date DESC',
};
const FACET_COLS = ['desk', 'subtopic', 'source']; // whitelist: interpolated into SQL below

const parseTags = (t) => { try { return JSON.parse(t); } catch { return []; } };

export function makeSearch(db) {
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) cache.set(sql, (st = db.prepare(sql)));
    return st;
  };
  const baseWhere = () => [DEDUPE, ...(HIDE_RESERVE ? ["COALESCE(s.mode, '') <> 'reserve'"] : [])];

  function listStories(sp) {
    const get = (k) => (sp.get(k) ?? '').trim();
    const match = buildMatch(get('q'));
    const where = baseWhere();
    const params = [];
    if (match) { where.push('stories_fts MATCH ?'); params.push(match); }
    if (MARKS[get('mark')]) where.push(MARKS[get('mark')]);
    for (const k of ['desk', 'subtopic', 'source']) {
      if (get(k)) { where.push(`s.${k} = ?`); params.push(get(k)); }
    }
    for (const t of sp.getAll('tag').slice(0, 5)) {
      where.push('EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value = ?)');
      params.push(t);
    }
    if (DATE_RE.test(get('from'))) { where.push('b.date >= ?'); params.push(get('from')); }
    if (DATE_RE.test(get('to'))) { where.push('b.date <= ?'); params.push(get('to')); }

    const from = match
      ? 'stories_fts JOIN stories s ON s.story_id = stories_fts.rowid JOIN briefs b ON b.brief_id = s.brief_id'
      : 'stories s JOIN briefs b ON b.brief_id = s.brief_id';
    let sort = get('sort');
    if (!SORTS[sort] || (sort === 'rank' && !match)) sort = match ? 'rank' : 'date_desc';
    const limit = Math.min(Math.max(parseInt(get('limit'), 10) || 25, 1), 100);
    const offset = Math.max(parseInt(get('offset'), 10) || 0, 0);
    const W = where.join(' AND ');

    try {
      const total = Number(prep(`SELECT COUNT(*) AS n FROM ${from} WHERE ${W}`).get(...params).n);
      const rows = prep(
        `SELECT s.story_id, s.brief_id, b.date, s.desk, s.subtopic, s.source, s.url, s.headline, s.blurb,
                s.why_care, s.tags, s.liked, s.saved,
                ${match ? 'highlight(stories_fts, 0, char(1), char(2))' : 'NULL'} AS h_headline,
                ${match ? 'highlight(stories_fts, 1, char(1), char(2))' : 'NULL'} AS h_blurb
           FROM ${from} WHERE ${W} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset);
      return {
        total,
        rows: rows.map((r) => ({ ...r, tags: parseTags(r.tags), liked: !!r.liked, saved: !!r.saved })),
      };
    } catch (e) {
      if (/fts5|malformed MATCH/i.test(String(e.message))) {
        throw Object.assign(new Error('bad search query'), { status: 400 });
      }
      throw e;
    }
  }

  function facets() {
    const base = `FROM stories s JOIN briefs b ON b.brief_id = s.brief_id`;
    const W = baseWhere().join(' AND ');
    const out = {};
    for (const col of FACET_COLS) {
      out[col] = prep(`SELECT s.${col} AS value, COUNT(*) AS n ${base} WHERE ${W} GROUP BY s.${col} ORDER BY n DESC`)
        .all().map((r) => ({ ...r }));
    }
    out.tag = prep(
      `SELECT j.value AS value, COUNT(*) AS n ${base}, json_each(s.tags) j WHERE ${W}
        GROUP BY j.value ORDER BY n DESC LIMIT 40`,
    ).all().map((r) => ({ ...r }));
    return out;
  }

  return { listStories, facets };
}