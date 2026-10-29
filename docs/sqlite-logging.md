# SQLite-Based Stateful Logging

The Daily Brief uses a **single SQLite database** (`daily_brief.db`, path from `config.json` `db_file`) as the
source of truth for all state: the candidate pool, generated briefs, stories, feedback, embeddings, author metadata,
and ranker model cache. Both the Python code (`src/db.py`) and the Node code (`server/lib/queries.js`,
`ranker/store.js`) open `schema.sql` on connect — every statement is idempotent.

SQLite runs in **WAL mode**. `daily_brief.db` is gitignored; do not sync `*.db`, `*-wal`, or `*-shm` files
through Syncthing/Obsidian Sync (WAL files corrupt under file sync). Consider an absolute `db_file` outside any
synced vault.

---

## 1. Schema Overview (`schema.sql`)

All tables are created with `CREATE TABLE IF NOT EXISTS`; `PRAGMA user_version = 2`.

### `candidate_pool` — the mutable item pool

| Column | Type | Notes |
|--------|------|-------|
| `item_id` | TEXT PK | 12-hex SHA1 prefix of canonical URL |
| `url` | TEXT NOT NULL | |
| `title` | TEXT NOT NULL | |
| `snippet` | TEXT NOT NULL DEFAULT '' | |
| `published` | TEXT | |
| `source` | TEXT NOT NULL | |
| `source_type` | TEXT NOT NULL DEFAULT 'commentary' | `newslike` \| `paperlike` \| `researchlike` \| `commentary` |
| `subtopic` | TEXT NOT NULL | |
| `desk` | TEXT NOT NULL | |
| `rel` | REAL NOT NULL | keyword relevance (0,1] |
| `first_seen` | TEXT NOT NULL | |
| `times_shown` | INTEGER NOT NULL DEFAULT 0 | |
| `rejected` | INTEGER NOT NULL DEFAULT 0 | |
| `last_shown` | TEXT | |

Index: `idx_pool_desk(desk)`.

### `briefs` — one row per generated brief (APPEND-ONLY)

| Column | Type | Notes |
|--------|------|-------|
| `brief_id` | INTEGER PK AUTOINCREMENT | |
| `date` | TEXT NOT NULL | local YYYY-MM-DD |
| `edition` | INTEGER NOT NULL | |
| `generated_at` | TEXT NOT NULL | UTC ISO-8601 |
| `model` | TEXT NOT NULL | LLM model(s) used |
| `llm_requests` | INTEGER NOT NULL DEFAULT 0 | |
| `counted` | INTEGER NOT NULL DEFAULT 1 | exactly one per date is `counted=1` |
| `rejected_ids` | TEXT NOT NULL DEFAULT '[]' | JSON array of item_ids the editor rejected |
| `desks` | TEXT NOT NULL | JSON desk titles/decks |
| `meta` | TEXT NOT NULL | JSON footer meta (engine, n_fresh, n_archive, n_explore, epsilon, pool, sources) |

Index: `idx_briefs_date(date, brief_id DESC)`.

**Same-day regeneration:** regenerating on the same day appends a new row, flips the previous row's `counted` to
`0`, and carries forward like/save marks for matching items (by `item_id`). `times_shown` is adjusted in memory so
the day's own stories don't look "already seen".

### `stories` — one row per story slot in a brief

| Column | Type | Notes |
|--------|------|-------|
| `story_id` | INTEGER PK AUTOINCREMENT | |
| `brief_id` | INTEGER REFERENCES briefs | ON DELETE CASCADE |
| `item_id` | TEXT NOT NULL | NOT a FK (pool rows get pruned) |
| `desk` | TEXT NOT NULL | |
| `position` | INTEGER NOT NULL | 0 = lead story |
| `headline` | TEXT NOT NULL | edited text |
| `blurb` | TEXT NOT NULL | edited text |
| `why_care` | TEXT NOT NULL DEFAULT '' | |
| `tags` | TEXT NOT NULL DEFAULT '[]' | JSON array |
| `significance` | INTEGER NOT NULL DEFAULT 3 | |
| `summarized` | INTEGER NOT NULL DEFAULT 1 | |
| `url` | TEXT NOT NULL | |
| `source` | TEXT NOT NULL | |
| `source_type` | TEXT NOT NULL DEFAULT 'commentary' | |
| `subtopic` | TEXT NOT NULL | |
| `kind` | TEXT NOT NULL DEFAULT 'fresh' | `fresh` \| `archive` |
| `mode` | TEXT | `greedy` \| `explore` \| `reserve` |
| `age_days` | REAL NOT NULL DEFAULT 0 | feature snapshot |
| `rel` | REAL NOT NULL DEFAULT 0 | feature snapshot |
| `times_shown_before` | INTEGER NOT NULL DEFAULT 0 | feature snapshot |
| `liked` | INTEGER NOT NULL DEFAULT 0 | |
| `saved` | INTEGER NOT NULL DEFAULT 0 | |
| `liked_at` | TEXT | |
| `saved_at` | TEXT | |

Indexes: `idx_stories_brief(brief_id, desk, position)`, `idx_stories_item(item_id)`.

### `training_examples` — view (one row per date+item, last occurrence wins)

| Columns | From |
|---------|------|
| `story_id`, `brief_id`, `date`, `generated_at`, `item_id`, `desk`, `position`, `subtopic`, `source`, `source_type`, `kind`, `mode`, `significance`, `summarized`, `age_days`, `rel`, `times_shown_before`, `headline`, `url`, `liked`, `saved` | `stories` + `briefs` |

Takes the `MAX(story_id)` per `(date, item_id)` so regeneration copies feedback forward and the last row has the
final state. Exported as JSONL at `/api/export/training.jsonl`.

### Ranker tables (new)

#### `embeddings`

| Column | Type | Notes |
|--------|------|-------|
| `item_id` | TEXT PK | pool/story item_id, or `ps:<id>` for perfect samples |
| `model` | TEXT NOT NULL | e.g. `TaylorAI/bge-micro-v2` |
| `text_hash` | TEXT NOT NULL | sha1[:12] of embedded text; re-embed on change |
| `dim` | INTEGER NOT NULL | 384 |
| `vec` | BLOB NOT NULL | Float32Array(384), L2-normalised |

Never pruned with the pool (orphaned non-`ps:` rows are cleaned by `store.prune`).

#### `item_meta` — authors survive pool pruning

| Column | Type | Notes |
|--------|------|-------|
| `item_id` | TEXT PK | |
| `authors` | TEXT NOT NULL DEFAULT '[]' | JSON array of raw author strings |

Written by Python `db.upsert_pool`; needed to retrain on old stories after pool pruning.

#### `ranker_state` — cached fitted artefacts

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | `fit_key`, `interests`, `model` |
| `value` | TEXT NOT NULL | JSON |
| `updated_at` | TEXT NOT NULL | |

`fitKey = SHA1([perfect, likedIds, trainingRows, config sections, ENCODING_VERSION])`. Cache hit → hydrate
interests + model; skip recomputation. `--force` ignores the cache.

---

## 2. Who Writes What

| Component | Language | Writes | Reads |
|-----------|----------|--------|-------|
| `src/db.py` | Python | `candidate_pool`, `item_meta`, `briefs`, `stories` | all tables |
| `server/lib/queries.js` | Node | `stories` (feedback via `setFeedback`) | all tables (reads `briefs` for listing) |
| `ranker/store.js` | Node | `embeddings`, `ranker_state` | `embeddings`, `item_meta`, `ranker_state` |
| `ranker/pipeline.js` | Node | (reads via store) | `embeddings`, `item_meta`, `ranker_state`, `candidate_pool`, `stories` |

### Concurrency

- **Single writer at a time:** `server/index.js` spawns `python src/brief.py` as a subprocess; the ranker CLI is
  also a separate process. SQLite's file-level locking plus WAL keeps concurrent readers safe.
- **WAL mode:** readers don't block writers and vice versa. `daily_brief.db-wal` / `daily_brief.db-shm` appear
  alongside the main file; checkpoint on clean shutdown.

---

## 3. Major Call Paths Involving the DB

### Path A: Brief generation (Python)

```
fetch_all() → classify() → db.upsert_pool(candidate_pool, item_meta)
    → db.prune_pool()                                          (drop stale pool rows)
    → SELECTION (keyword in Python, or LR via node ranker/cli.js)
    → apply_editor()                                           (LLM edits)
    → db.append_brief(briefs, stories)                         (single atomic append)
                                                    → carry forward like/save (same-day regen)
```

### Path B: Ranker (Node CLI)

```
node ranker/cli.js embed
    → store.missingEmbeddings (candidate_pool + stories LEFT JOIN embeddings)
    → embedder.embedTexts()                                    (bge-micro-v2)
    → store.INSERT embeddings
    → store.prune()                                            (drop orphaned non-ps: embeddings)

node ranker/cli.js refit
    → store.likedIds (stories JOIN briefs, liked/saved, lookback)
    → store.trainingRows (training_examples view JOIN item_meta)
    → fitKey cache check on ranker_state
    → build interests (Ward) + cross-fit + fit model
    → store.setState('interests'/'model'/'fit_key')

node ranker/cli.js select
    → store: embeddings + item_meta + pool
    → prepareCandidates → model.p → selectBrief
    → stdout JSON (stderr = logs only)
```

### Path C: Feedback (UI → DB → Ranker)

```
Electron/Obsidian: user clicks like/save
    → client.js POST /api/stories/<id>/feedback { action: "like"|"save", value: boolean }
    → server/app.js → queries.setFeedback()  (stories.liked / saved)
    → Next ranker refit reads likedIds → Ward medoids + training labels
```

---

## 4. Statefulness Summary

| State | Where it lives | How it persists |
|-------|---------------|-----------------|
| Candidate pool items | `candidate_pool` | Upserted each fetch; pruned by `pool.max_age_days` |
| Briefs & stories | `briefs`, `stories` | Append-only; same-day regen supersedes (`counted=0`) |
| Like/save feedback | `stories.liked` / `stories.saved` | Via `/api/stories/<id>/feedback`; flows into ranker training |
| Training examples | `training_examples` view | Exported as JSONL for `eval` / external analysis |
| Embeddings | `embeddings` | Cached by `text_hash`; `ps:<id>` perfect samples never pruned |
| Author metadata | `item_meta` | Survives pool pruning (retrain on old stories) |
| Fitted model + interests | `ranker_state` | Cached by `fitKey`; hydrated on cache hit |

---

## 5. Backup & Maintenance

- `state.json`, `issue-history.json`, and day JSONs are archived in `backup/` (pre-migration sources).
- `logs/` and `*.db` are gitignored.
- `migrate_to_sqlite.py` is the one-off migration from `state.json` + edition dirs (run once).
- Before any schema change, back up `daily_brief.db`.

---

## 6. Related Docs

| Topic | File |
|-------|------|
| Project architecture & call paths | `docs/architecture.md` |
| Bayesian LR + Ward clustering model | `docs/model.md` |
| Electron / Obsidian / Web usage | `docs/interfaces.md` |
| Experiments & simulate functionality | `docs/experiments.md` |
| Ranker CLI reference | `ranker/README.md` |
| Full tunable configuration | `config.json` |
