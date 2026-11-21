// Unique sessions card: per-session like and save counts.
//
// A session is the client-generated UUID sent as X-Session-Id and stored in
// localStorage as db-session-id (server/public/client.js). Likes and saves are
// keyed by (session_id, item_id), so this card unions both tables, groups by
// session, and returns:
//   - the five most active sessions (likes + saves, then likes),
//   - the distribution of likes per session and saves per session, which the
//     page plots as x = likes/saves, y = number of sessions.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultDataDir } from '../../../user/datadir.js';
import { loadConfig } from '../../../user/config.js';
import { Store } from '../../../ranker/store.js';

const TOP_N = 5;

function openStore(dataDir) {
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  return new Store(resolve(dataDir, cfg.db_file ?? 'daily_brief.db'));
}

/** Hash the current like/save table state so the card goes stale when it changes. */
export async function sourceHash(dataDir = defaultDataDir()) {
  const store = openStore(dataDir);
  try {
    const snapshot = (table, column) => {
      const row = store.db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(${column}), '') AS last FROM ${table}`,
      ).get();
      return `${row.n}:${row.last}`;
    };
    return createHash('sha256')
      .update(`${snapshot('likes', 'liked_at')}|${snapshot('saves', 'saved_at')}`)
      .digest('hex');
  } finally {
    store.close();
  }
}

/** Distribution arrays: x = interactions per session, y = number of sessions. */
function distribution(rows, key) {
  if (!rows.length) return { x: [], y: [] };
  const buckets = new Map();
  for (const row of rows) {
    const n = row[key];
    buckets.set(n, (buckets.get(n) ?? 0) + 1);
  }
  // Only observed counts: a session count of zero adds an unreadable run of
  // empty ticks when one session is much more active than the others.
  const x = [...buckets.keys()].sort((a, b) => a - b);
  return { x, y: x.map((n) => buckets.get(n)) };
}

export async function generate(dataDir = defaultDataDir()) {
  const store = openStore(dataDir);
  try {
    const sessions = store.db.prepare(`
      SELECT session_id AS sessionId,
             SUM(CASE WHEN kind = 'like' THEN 1 ELSE 0 END) AS likes,
             SUM(CASE WHEN kind = 'save' THEN 1 ELSE 0 END) AS saves
      FROM (
        SELECT session_id, 'like' AS kind FROM likes
        UNION ALL
        SELECT session_id, 'save' AS kind FROM saves
      )
      GROUP BY session_id
    `).all();

    for (const row of sessions) row.total = row.likes + row.saves;
    sessions.sort((a, b) =>
      b.total - a.total ||
      b.likes - a.likes ||
      String(a.sessionId).localeCompare(String(b.sessionId)));

    return {
      sessions: sessions.slice(0, TOP_N),
      nSessions: sessions.length,
      totalLikes: sessions.reduce((sum, row) => sum + row.likes, 0),
      totalSaves: sessions.reduce((sum, row) => sum + row.saves, 0),
      likeDist: distribution(sessions, 'likes'),
      saveDist: distribution(sessions, 'saves'),
    };
  } finally {
    store.close();
  }
}
