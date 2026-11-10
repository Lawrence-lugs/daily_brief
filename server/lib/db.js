/** SQLite persistence for the daily brief (port of src/db.py).

Uses node:sqlite DatabaseSync (synchronous, built into Node >= 22.13).
Every write is a short BEGIN IMMEDIATE ... COMMIT transaction.
WAL + busy_timeout. Schema from schema.sql (same file Python used).
*/
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = resolve(__dirname, '..', '..', 'schema.sql');
const UTC_OFFSET = 0; // all timestamps stored as UTC ISO strings

function toIso(d) {
  return d.toISOString();
}

export function connect(dbPath) {
  const conn = new DatabaseSync(dbPath);
  conn.exec('PRAGMA journal_mode=WAL;');
  conn.exec('PRAGMA busy_timeout=30000;');
  conn.exec('PRAGMA foreign_keys=ON;');
  conn.exec('PRAGMA synchronous=NORMAL;');
  conn.exec(readFileSync(SCHEMA_FILE, { encoding: 'utf8' }));

  // Migration: add cluster and core columns to stories if missing
  for (const [col, ddl] of [
    ['cluster', 'ALTER TABLE stories ADD COLUMN cluster TEXT'],
    ['core', 'ALTER TABLE stories ADD COLUMN core INTEGER NOT NULL DEFAULT 0'],
    ['score_p', 'ALTER TABLE stories ADD COLUMN score_p REAL'],
    ['score_v', 'ALTER TABLE stories ADD COLUMN score_v REAL'],
    ['cos_dist', 'ALTER TABLE stories ADD COLUMN cos_dist REAL'],
    ['cluster_size', 'ALTER TABLE stories ADD COLUMN cluster_size INTEGER'],
    ['cluster_pool', 'ALTER TABLE stories ADD COLUMN cluster_pool INTEGER'],
    ['medoid_id', 'ALTER TABLE stories ADD COLUMN medoid_id TEXT'],
  ]) {
    try { conn.exec(ddl); } catch (e) {
      if (!String(e).includes('duplicate column name')) throw e;
    }
  }

  // One-time FTS backfill
  const ftsRow = conn.prepare("SELECT 1 FROM ranker_state WHERE key='fts_v1'").get();
  if (!ftsRow) {
    conn.exec("INSERT INTO stories_fts(stories_fts) VALUES('rebuild')");
    conn.prepare("INSERT OR REPLACE INTO ranker_state(key,value,updated_at) VALUES('fts_v1','1',?)").run(new Date().toISOString());
  }
  return conn;
}

/** Write transaction wrapper. */
export function tx(conn, callback) {
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = callback(conn);
    conn.exec('COMMIT');
    return result;
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw e;
  }
}

function parseDate(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch { return null; }
}

function ageDays(row, now) {
  const d = parseDate(row.published) || parseDate(row.first_seen) || now;
  return Math.max(0, (now - d) / 86400000);
}

/** candidate_pool ----------------------------------------------------------------- */

export function loadPool(conn) {
  const out = [];
  for (const r of conn.prepare('SELECT * FROM candidate_pool').all()) {
    const d = { ...r };
    d.id = d.item_id;
    delete d.item_id;
    out.push(d);
  }
  return out;
}

export function loadLikedIds(conn, cutoffDate = null) {
  let rows;
  if (cutoffDate) {
    rows = conn.prepare(`
      SELECT DISTINCT s.item_id
      FROM stories s JOIN briefs b ON b.brief_id = s.brief_id
      WHERE (s.liked = 1 OR s.saved = 1) AND b.date >= ?
    `).all(cutoffDate);
  } else {
    rows = conn.prepare(`
      SELECT DISTINCT s.item_id
      FROM stories s JOIN briefs b ON b.brief_id = s.brief_id
      WHERE s.liked = 1 OR s.saved = 1
    `).all();
  }
  return new Set(rows.map(r => r.item_id));
}

export function upsertPool(conn, fresh, now) {
  const existing = new Set(conn.prepare('SELECT item_id FROM candidate_pool').all().map(r => r.item_id));
  let added = 0;
  tx(conn, () => {
    for (const it of fresh) {
      if (!existing.has(it.id)) { added += 1; existing.add(it.id); }
      conn.prepare(`
        INSERT INTO candidate_pool
          (item_id, url, title, snippet, published, source, source_type, subtopic, desk, rel, first_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          rel = excluded.rel,
          subtopic = excluded.subtopic,
          desk = excluded.desk,
          source_type = excluded.source_type,
          snippet = CASE WHEN candidate_pool.snippet = '' THEN excluded.snippet ELSE candidate_pool.snippet END
      `).run(
        it.id, it.url, it.title, it.snippet ?? '', it.published ?? null,
        it.source, it.source_type ?? 'commentary', it.subtopic, it.desk,
        it.rel, now.toISOString(),
      );
      // Upsert authors into item_meta
      const authorsJson = JSON.stringify(it.authors ?? []);
      if (authorsJson !== '[]') {
        conn.prepare(`
          INSERT INTO item_meta(item_id, authors) VALUES (?, ?)
          ON CONFLICT(item_id) DO UPDATE SET authors = excluded.authors WHERE excluded.authors <> '[]'
        `).run(it.id, authorsJson);
      }
    }
  });
  return added;
}

export function deletePool(conn, ids) {
  if (ids.length) {
    tx(conn, () => {
      const stmt = conn.prepare('DELETE FROM candidate_pool WHERE item_id = ?');
      for (const id of ids) stmt.run(id);
    });
  }
}

export function prunePool(conn, now, maxAgeDays) {
  const rows = conn.prepare('SELECT item_id, published, first_seen FROM candidate_pool').all();
  const stale = rows
    .filter(r => ageDays(r, now) > maxAgeDays)
    .map(r => r.item_id);
  if (stale.length) {
    tx(conn, () => {
      const stmt = conn.prepare('DELETE FROM candidate_pool WHERE item_id = ?');
      for (const id of stale) stmt.run(id);
    });
  }
  return stale.length;
}

/** same-day regeneration ------------------------------------------------------------ */

export function sameDayCounts(conn, dateKey) {
  const shown = {};
  const rejected = {};
  const briefs = conn.prepare('SELECT brief_id, rejected_ids FROM briefs WHERE date = ? AND counted = 1').all(dateKey);
  for (const b of briefs) {
    const stories = conn.prepare('SELECT item_id FROM stories WHERE brief_id = ?').all(b.brief_id);
    for (const r of stories) { shown[r.item_id] = (shown[r.item_id] || 0) + 1; }
    for (const iid of JSON.parse(b.rejected_ids)) { rejected[iid] = (rejected[iid] || 0) + 1; }
  }
  return [shown, rejected];
}

function supersedeLocked(conn, dateKey) {
  const [shown, rejected] = sameDayCounts(conn, dateKey);
  for (const [iid, n] of Object.entries(shown)) {
    conn.prepare('UPDATE candidate_pool SET times_shown = MAX(times_shown - ?, 0) WHERE item_id = ?').run(n, iid);
  }
  for (const [iid, n] of Object.entries(rejected)) {
    conn.prepare('UPDATE candidate_pool SET rejected = MAX(rejected - ?, 0) WHERE item_id = ?').run(n, iid);
  }
  conn.prepare('UPDATE briefs SET counted = 0 WHERE date = ? AND counted = 1').run(dateKey);
}

const _CARRY = `
UPDATE stories SET
  liked    = COALESCE((SELECT s2.liked    FROM stories s2 JOIN briefs b2 ON b2.brief_id = s2.brief_id
                       WHERE b2.date = :date AND s2.brief_id < :bid AND s2.item_id = stories.item_id
                       ORDER BY s2.brief_id DESC LIMIT 1), 0),
  saved    = COALESCE((SELECT s2.saved    FROM stories s2 JOIN briefs b2 ON b2.brief_id = s2.brief_id
                       WHERE b2.date = :date AND s2.brief_id < :bid AND s2.item_id = stories.item_id
                       ORDER BY s2.brief_id DESC LIMIT 1), 0),
  liked_at = (SELECT s2.liked_at FROM stories s2 JOIN briefs b2 ON b2.brief_id = s2.brief_id
              WHERE b2.date = :date AND s2.brief_id < :bid AND s2.item_id = stories.item_id
              ORDER BY s2.brief_id DESC LIMIT 1),
  saved_at = (SELECT s2.saved_at FROM stories s2 JOIN briefs b2 ON b2.brief_id = s2.brief_id
              WHERE b2.date = :date AND s2.brief_id < :bid AND s2.item_id = stories.item_id
              ORDER BY s2.brief_id DESC LIMIT 1)
WHERE brief_id = :bid
`;

const _STORY_COLS = [
  'brief_id', 'item_id', 'desk', 'position', 'headline', 'blurb', 'why_care', 'tags',
  'significance', 'summarized', 'url', 'source', 'source_type', 'subtopic', 'kind', 'mode',
  'age_days', 'rel', 'times_shown_before', 'cluster', 'core',
  'score_p', 'score_v', 'cos_dist', 'cluster_size', 'cluster_pool', 'medoid_id',
];

function num(v, cast = Number) {
  return v === null ? null : cast(v);
}

function storyRow(bid, desk, pos, s) {
  return [
    bid, s.id, desk, pos, s.headline, s.blurb, s.why_care ?? '',
    JSON.stringify(s.tags ?? []), Number(s.significance ?? 3), Number(Boolean(s.summarized ?? true)),
    s.url, s.source, s.source_type ?? 'commentary', s.subtopic, s.kind ?? 'fresh',
    s.mode, Number(s.age_days ?? 0), Number(s.rel ?? 0),
    Number(s.times_shown ?? 0), s.cluster ?? null, Number(Boolean(s.core ?? false)),
    num(s.p), num(s.V), num(s.cos_dist),
    num(s.cluster_size, Math.round), num(s.cluster_pool, Math.round), s.medoid_id ?? null,
  ];
}

export function insertBrief(conn, { dateKey, generatedAt, model, llmRequests, rejectedIds, desksOut, meta, edition = null, counted = 1 }) {
  if (edition === null) {
    const row = conn.prepare('SELECT COUNT(DISTINCT date) AS n FROM briefs WHERE date <> ?').get(dateKey);
    edition = (row ? row.n : 0) + 1;
  }
  const desksMeta = {};
  for (const [k, v] of Object.entries(desksOut)) desksMeta[k] = { title: v.title, deck: v.deck };
  const cur = conn.prepare(`
    INSERT INTO briefs (date, edition, generated_at, model, llm_requests, counted, rejected_ids, desks, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    dateKey, edition, generatedAt, model, llmRequests, counted,
    JSON.stringify(rejectedIds), JSON.stringify(desksMeta), JSON.stringify(meta),
  );
  const bid = cur.lastInsertRowid;
  for (const [desk, d] of Object.entries(desksOut)) {
    for (let pos = 0; pos < d.stories.length; pos++) {
      const s = d.stories[pos];
      conn.prepare(`INSERT INTO stories (${_STORY_COLS.join(', ')}) VALUES (${_STORY_COLS.map(() => '?').join(', ')})`)
        .run(...storyRow(bid, desk, pos, s));
    }
  }
  conn.prepare(_CARRY).run({ date: dateKey, bid });
  return bid;
}

export function appendBrief(conn, { dateKey, now, model, llmRequests, rejectedIds, desksOut, meta }) {
  const ts = now.toISOString();
  return tx(conn, () => {
    supersedeLocked(conn, dateKey);
    const bid = insertBrief(conn, { dateKey, generatedAt: ts, model, llmRequests, rejectedIds, desksOut, meta });
    const shown = [];
    for (const d of Object.values(desksOut)) {
      for (const s of d.stories) shown.push(s.id);
    }
    const stmtShown = conn.prepare('UPDATE candidate_pool SET times_shown = times_shown + 1, last_shown = ? WHERE item_id = ?');
    for (const id of shown) stmtShown.run(ts, id);
    const stmtRej = conn.prepare('UPDATE candidate_pool SET rejected = rejected + 1 WHERE item_id = ?');
    for (const id of rejectedIds) stmtRej.run(id);
    return bid;
  });
}
