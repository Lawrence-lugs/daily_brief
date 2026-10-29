-- Daily brief: single source of truth. Opened by BOTH python (src/db.py) and node (server/lib/queries.js).
-- Every statement is idempotent; both sides execute this whole file on connect.
-- Timestamps are UTC ISO-8601 strings. `date` is the LOCAL calendar day (YYYY-MM-DD) of generation.

-- 1. candidate_pool: replaces state.json["items"]. Mutable.
CREATE TABLE IF NOT EXISTS candidate_pool (
  item_id      TEXT PRIMARY KEY,            -- 12-hex sha1 prefix of canonical url
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  snippet      TEXT NOT NULL DEFAULT '',
  published    TEXT,
  source       TEXT NOT NULL,
  source_type  TEXT NOT NULL DEFAULT 'commentary',   -- newslike | paperlike | researchlike | commentary
  subtopic     TEXT NOT NULL,
  desk         TEXT NOT NULL,
  rel          REAL NOT NULL,
  first_seen   TEXT NOT NULL,
  times_shown  INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  last_shown   TEXT
);
CREATE INDEX IF NOT EXISTS idx_pool_desk ON candidate_pool(desk);

-- 2. briefs: replaces issue-history.json + state.json["editions"]. APPEND-ONLY
--    (regenerating the same day appends a new row; `counted` marks the one whose
--    shown/rejected counters are currently reflected in candidate_pool).
CREATE TABLE IF NOT EXISTS briefs (
  brief_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  edition       INTEGER NOT NULL,
  generated_at  TEXT NOT NULL,
  model         TEXT NOT NULL,
  llm_requests  INTEGER NOT NULL DEFAULT 0,
  counted       INTEGER NOT NULL DEFAULT 1,
  rejected_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON array of item_ids the editor rejected
  desks         TEXT NOT NULL,                -- JSON {"primary":{"title":..,"deck":..},"science":{..}}
  meta          TEXT NOT NULL                 -- JSON footer meta (model, n_fresh, n_archive, n_explore, epsilon, pool, sources)
);
CREATE INDEX IF NOT EXISTS idx_briefs_date ON briefs(date, brief_id DESC);

-- 3. stories: replaces {date}.json + localStorage. One row per story slot in a brief.
--    Carries the edited text AND a snapshot of the features at pick time (for the recommender).
CREATE TABLE IF NOT EXISTS stories (
  story_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id     INTEGER NOT NULL REFERENCES briefs(brief_id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,                 -- NOT a foreign key: pool rows get pruned
  desk         TEXT NOT NULL,
  position     INTEGER NOT NULL,              -- 0 = lead story of the desk
  headline     TEXT NOT NULL,
  blurb        TEXT NOT NULL,
  why_care     TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',    -- JSON array
  significance INTEGER NOT NULL DEFAULT 3,
  summarized   INTEGER NOT NULL DEFAULT 1,
  url          TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_type  TEXT NOT NULL DEFAULT 'commentary',
  subtopic     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'fresh', -- fresh | archive
  mode         TEXT,                          -- greedy | explore | reserve
  age_days     REAL NOT NULL DEFAULT 0,       -- feature snapshot
  rel          REAL NOT NULL DEFAULT 0,       -- feature snapshot
  times_shown_before INTEGER NOT NULL DEFAULT 0, -- feature snapshot
  liked        INTEGER NOT NULL DEFAULT 0,
  saved        INTEGER NOT NULL DEFAULT 0,
  liked_at     TEXT,
  saved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_stories_brief ON stories(brief_id, desk, position);
CREATE INDEX IF NOT EXISTS idx_stories_item  ON stories(item_id);

-- Recommender input: one row per (date, item), taking the LAST occurrence
-- (regeneration copies feedback forward, so the last row has the final state).
CREATE VIEW IF NOT EXISTS training_examples AS
SELECT s.story_id, s.brief_id, b.date, b.generated_at, s.item_id, s.desk, s.position,
       s.subtopic, s.source, s.source_type, s.kind, s.mode, s.significance, s.summarized,
       s.age_days, s.rel, s.times_shown_before, s.headline, s.url, s.liked, s.saved
FROM stories s JOIN briefs b ON b.brief_id = s.brief_id
WHERE s.story_id = (
  SELECT MAX(s2.story_id) FROM stories s2 JOIN briefs b2 ON b2.brief_id = s2.brief_id
  WHERE b2.date = b.date AND s2.item_id = s.item_id);

-- embeddings: item_id is a pool/story item_id, or 'ps:<id>' for perfect samples. Never pruned with the pool.
CREATE TABLE IF NOT EXISTS embeddings (
  item_id   TEXT PRIMARY KEY,
  model     TEXT NOT NULL,
  text_hash TEXT NOT NULL,          -- sha1[:12] of the embedded text; re-embed when it changes
  dim       INTEGER NOT NULL,
  vec       BLOB NOT NULL           -- Float32Array(384), L2-normalised
);
-- authors survive pool pruning (needed to retrain on old stories)
CREATE TABLE IF NOT EXISTS item_meta (
  item_id TEXT PRIMARY KEY,
  authors TEXT NOT NULL DEFAULT '[]'   -- JSON array of raw author strings
);
-- fitted artefacts: 'fit_key', 'interests', 'model'
CREATE TABLE IF NOT EXISTS ranker_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);

PRAGMA user_version = 2;
