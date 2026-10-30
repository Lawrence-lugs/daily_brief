// SQLite access for the server (node:sqlite, zero npm deps; needs Node >= 22.13).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  ]) {
    try { db.exec(ddl); } catch (e) { if (!String(e).includes('duplicate column name')) throw e; }
  }
  return db;
}

const FEEDBACK = { like: ['liked', 'liked_at'], save: ['saved', 'saved_at'] };

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
    stories: db.prepare('SELECT * FROM stories WHERE brief_id = ? ORDER BY desk, position'),
    list: db.prepare('SELECT brief_id, date, generated_at, model, meta FROM briefs ORDER BY brief_id DESC LIMIT ?'),
    story: db.prepare('SELECT story_id, liked, saved FROM stories WHERE story_id = ?'),
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
    latestBriefId(date) {
      const r = date ? S.latestOnDate.get(date) : S.latestAny.get();
      return r ? r.brief_id : null;
    },

    /** Brief with desks[desk] = {title, deck, stories:[...]} (stories ordered by position). */
    getBrief(briefId) {
      const b = S.brief.get(briefId);
      if (!b) return null;
      const desksMeta = JSON.parse(b.desks);
      const desks = {};
      for (const k of Object.keys(desksMeta)) desks[k] = { ...desksMeta[k], stories: [] };
      for (const r of S.stories.all(briefId)) {
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

    /** Set one flag; value is boolean. Returns {story_id, liked, saved} or null if no such story. */
    setFeedback(storyId, action, value) {
      const cols = FEEDBACK[action]; // whitelist => safe to interpolate column names
      if (!cols) throw new Error(`bad action ${action}`);
      const now = value ? new Date().toISOString() : null;
      const r = db.prepare(`UPDATE stories SET ${cols[0]} = ?, ${cols[1]} = ? WHERE story_id = ?`)
        .run(value ? 1 : 0, now, storyId);
      return Number(r.changes) ? { ...S.story.get(storyId) } : null;
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
  };
}
