// SQLite access for the server (node:sqlite, zero npm deps; needs Node >= 22.13).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function openDb(file, schemaFile) {
  const db = new DatabaseSync(file);
  // Python holds write locks only for milliseconds; busy_timeout covers it. Keep it short because
  // DatabaseSync blocks the event loop while waiting.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  db.exec(readFileSync(schemaFile, 'utf8')); // idempotent; same file python executes
  return db;
}

const FEEDBACK = { like: ['liked', 'liked_at'], save: ['saved', 'saved_at'] };

export function makeQueries(db) {
  const S = {
    latestAny: db.prepare('SELECT brief_id FROM briefs ORDER BY brief_id DESC LIMIT 1'),
    latestOnDate: db.prepare('SELECT brief_id FROM briefs WHERE date = ? ORDER BY brief_id DESC LIMIT 1'),
    brief: db.prepare('SELECT * FROM briefs WHERE brief_id = ?'),
    stories: db.prepare('SELECT * FROM stories WHERE brief_id = ? ORDER BY desk, position'),
    list: db.prepare('SELECT brief_id, date, generated_at, model FROM briefs ORDER BY brief_id DESC LIMIT ?'),
    story: db.prepare('SELECT story_id, liked, saved FROM stories WHERE story_id = ?'),
    training: db.prepare('SELECT * FROM training_examples ORDER BY story_id'),
  };

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
      return S.list.all(limit).map((r) => ({ ...r }));
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
  };
}
