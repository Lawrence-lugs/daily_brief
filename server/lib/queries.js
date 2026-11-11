// SQLite access for the server (node:sqlite, zero npm deps; needs Node >= 22.13).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeSearch, ensureFtsBuilt } from './search.js';

export function openDb(file, schemaFile) {
  const db = new DatabaseSync(file);
  // Python holds write locks only for milliseconds; busy_timeout covers it. Keep it short because
  // DatabaseSync blocks the event loop while waiting.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  db.exec(readFileSync(schemaFile, 'utf8')); // idempotent; same file python executes
  // Migration: add cluster and core columns to stories if missing
  for (const ddl of [
    'ALTER TABLE stories ADD COLUMN cluster TEXT',
    'ALTER TABLE stories ADD COLUMN core INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE stories ADD COLUMN score_p REAL',
    'ALTER TABLE stories ADD COLUMN score_v REAL',
    'ALTER TABLE stories ADD COLUMN cos_dist REAL',
    'ALTER TABLE stories ADD COLUMN cluster_size INTEGER',
    'ALTER TABLE stories ADD COLUMN cluster_pool INTEGER',
    'ALTER TABLE stories ADD COLUMN medoid_id TEXT',
  ]) {
    try { db.exec(ddl); } catch (e) { if (!String(e).includes('duplicate column name')) throw e; }
  }
  ensureFtsBuilt(db); // one-time backfill; no-op afterwards
  // Migration v3→v4: copy stranded like/save data from stories columns to new likes/saves tables.
  // Only needed on old DBs where stories still has liked/saved columns.
  const hasLikedCol = db.prepare("SELECT 1 FROM pragma_table_info('stories') WHERE name='liked'").get();
  if (hasLikedCol) {
    db.prepare(`
      INSERT OR IGNORE INTO likes (session_id, item_id, liked_at)
      SELECT 'legacy', s.item_id, COALESCE(s.liked_at, b.generated_at)
      FROM stories s JOIN briefs b ON b.brief_id = s.brief_id WHERE s.liked = 1
    `).run();
    db.prepare(`
      INSERT OR IGNORE INTO saves (session_id, item_id, saved_at)
      SELECT 'legacy', s.item_id, COALESCE(s.saved_at, b.generated_at)
      FROM stories s JOIN briefs b ON b.brief_id = s.brief_id WHERE s.saved = 1
    `).run();
    console.error('[migrate] copied stranded like/save data from stories to likes/saves tables');
  }
  return db;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function loadPerfectSamples(root) {
  const psFile = resolve(root, 'perfect_samples.json');
  try {
    return JSON.parse(readFileSync(psFile, 'utf8'));
  } catch {
    return [];
  }
}

export function makeQueries(db, root = '.') {
  const S = {
    latestAny: db.prepare('SELECT brief_id FROM briefs ORDER BY brief_id DESC LIMIT 1'),
    latestOnDate: db.prepare('SELECT brief_id FROM briefs WHERE date = ? ORDER BY brief_id DESC LIMIT 1'),
    brief: db.prepare('SELECT * FROM briefs WHERE brief_id = ?'),
    // Stories for a brief, with like/save state for the given session_id (passed at query time).
    stories: db.prepare(`
      SELECT s.*,
             EXISTS(SELECT 1 FROM likes l WHERE l.item_id = s.item_id AND l.session_id = ?) AS liked,
             EXISTS(SELECT 1 FROM saves sv WHERE sv.item_id = s.item_id AND sv.session_id = ?) AS saved
      FROM stories s WHERE s.brief_id = ? ORDER BY s.desk, s.position
    `),
    list: db.prepare('SELECT brief_id, date, generated_at, model, meta FROM briefs WHERE brief_id IN (SELECT MAX(brief_id) FROM briefs GROUP BY date) ORDER BY brief_id DESC LIMIT ?'),
    story: db.prepare('SELECT story_id, item_id FROM stories WHERE story_id = ?'),
    training: db.prepare('SELECT * FROM training_examples ORDER BY story_id'),
    // Ranker state
    getRankerState: db.prepare('SELECT value FROM ranker_state WHERE key = ?'),
    // Medoid title resolution
    poolItem: db.prepare('SELECT title FROM candidate_pool WHERE item_id = ?'),
    storyItem: db.prepare('SELECT headline AS title FROM stories WHERE item_id = ? ORDER BY story_id DESC LIMIT 1'),
  };

  const perfectSamples = loadPerfectSamples(root);
  const perfectById = new Map(perfectSamples.map((ps) => [`ps:${ps.id}`, ps.title]));

  function resolveMedoidTitle(medoidId) {
    if (!medoidId) return null;
    // Perfect sample: ps:<id>
    if (medoidId.startsWith('ps:')) {
      return perfectById.get(medoidId) ?? medoidId;
    }
    // Pool item or story item
    const poolRow = S.poolItem.get(medoidId);
    if (poolRow) return poolRow.title;
    const storyRow = S.storyItem.get(medoidId);
    if (storyRow) return storyRow.title;
    return medoidId;
  }

  // Load fitted interests from ranker_state
  function getInterests() {
    const row = S.getRankerState.get('interests');
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  return {
    ...makeSearch(db), // listStories(searchParams), facets()

    latestBriefId(date) {
      const r = date ? S.latestOnDate.get(date) : S.latestAny.get();
      return r ? r.brief_id : null;
    },

    /** Brief with desks[desk] = {title, deck, stories:[...]} (stories ordered by position). */
    getBrief(briefId, sessionId = '') {
      if (sessionId !== '' && !SESSION_ID_RE.test(sessionId)) {
        throw new Error(`invalid session_id: ${sessionId}`);
      }
      const b = S.brief.get(briefId);
      if (!b) return null;
      const desksMeta = JSON.parse(b.desks);
      const desks = {};
      for (const k of Object.keys(desksMeta)) desks[k] = { ...desksMeta[k], stories: [] };
      // stories() takes (session_id, session_id, brief_id)
      const sid = sessionId ?? '';
      for (const r of S.stories.all(sid, sid, briefId)) {
        const d = (desks[r.desk] ??= { title: r.desk, deck: '', stories: [] });
        d.stories.push({ ...r, tags: JSON.parse(r.tags), summarized: !!r.summarized });
      }
      return { brief: { ...b, meta: JSON.parse(b.meta), rejected_ids: JSON.parse(b.rejected_ids) }, desks };
    },

    listBriefs(limit = 30) {
      return S.list.all(limit).map((r) => {
        const meta = r.meta ? JSON.parse(r.meta) : {};
        return { ...r, engine: meta.engine ?? 'keyword' };
      });
    },

    /** Toggle like/save for an item (resolved from story_id) under a session.
     *  Returns {item_id, liked, saved} or null if no such story. */
    setFeedback(storyId, sessionId, action, value) {
      if (sessionId !== '' && !SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session_id: ${sessionId}`);
      const storyRow = S.story.get(storyId);
      if (!storyRow) return null;
      const itemId = storyRow.item_id;
      const now = value ? new Date().toISOString() : null;
      if (action === 'like') {
        if (value) {
          db.prepare('INSERT OR IGNORE INTO likes (session_id, item_id, liked_at) VALUES (?, ?, ?)')
            .run(sessionId, itemId, now);
        } else {
          db.prepare('DELETE FROM likes WHERE session_id = ? AND item_id = ?').run(sessionId, itemId);
        }
      } else if (action === 'save') {
        if (value) {
          db.prepare('INSERT OR IGNORE INTO saves (session_id, item_id, saved_at) VALUES (?, ?, ?)')
            .run(sessionId, itemId, now);
        } else {
          db.prepare('DELETE FROM saves WHERE session_id = ? AND item_id = ?').run(sessionId, itemId);
        }
      } else {
        throw new Error(`bad action ${action}`);
      }
      // Return current like/saved state for this item in this session
      const liked = db.prepare('SELECT 1 FROM likes WHERE session_id = ? AND item_id = ?')
        .get(sessionId, itemId) ? 1 : 0;
      const saved = db.prepare('SELECT 1 FROM saves WHERE session_id = ? AND item_id = ?')
        .get(sessionId, itemId) ? 1 : 0;
      return { item_id: itemId, liked, saved };
    },

    trainingRows() {
      return S.training.all().map((r) => ({ ...r }));
    },

    // New: get fitted interests with resolved medoid titles
    getInterestsWithMedoidTitles() {
      const interests = getInterests();
      if (!interests || !interests.clusters) return null;
      return {
        ...interests,
        clusters: interests.clusters.map((c) => ({
          ...c,
          medoidTitle: resolveMedoidTitle(c.medoid),
        })),
      };
    },

    medoidTitle: resolveMedoidTitle,
  };
}
