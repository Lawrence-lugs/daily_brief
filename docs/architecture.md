# Architecture & Major Call Paths

This document describes the overall project architecture of the Daily Brief, its major components, and how a request
flows through the system from data fetching to rendering. It is a companion to the per-module docs
(`docs/model.md`, `docs/interfaces.md`, `docs/sqlite-logging.md`, `docs/experiments.md`) and the ranker README
(`ranker/README.md`).

## System Overview

The Daily Brief is a desktop-only "front page" of research news:

- **Python** (`src/`) fetches feeds, classifies items into subtopics/desks, upserts them into a shared SQLite
  database, and runs a selection engine (keyword legacy or new Bayesian LR).
- **Node.js** (`server/`) serves the same SQLite database over `http://127.0.0.1:4873/`, renders HTML/Tailwind,
  and runs background jobs (background feed refresh, auto-shutdown).
- **Node ESM** (`ranker/`) is the new Bayesian logistic-regression + Ward-clustering ranker. It shares the same
  SQLite DB and reads/writes ranker state via `ranker_state`.
- **UI**: an Electron window (`electron/main.cjs`) or an Obsidian dataviewjs iframe (`obsidian/daily-brief.md`),
  both loading the same localhost URL.

```
                      ┌─────────────────────────────────────┐
                      │         SQLite DB (daily_brief.db)   │
                      │  candidate_pool, briefs, stories     │
                      │  embeddings, item_meta, ranker_state  │
                      └──────────┬────────────────┬─────────┘
                                 │                │
      ┌─────────────────────────┘                └─────────────────────────┐
      │                                                                    │
 ┌────▼────┐                                                          ┌───▼───┐
 │ Python  │                                                          │ Node  │
 │ src/    │                                                          │ server│
 │ brief.py│  fetch/classify/select → DB                              │ index │
 │ db.py   │                                                          │ app.js│
 │ agent.py│                                                          │ lib/  │
 └────┬────┘     ┌───────────────────────┐                            │ queries│
      │          │                       │                            │ render│
      │    ┌─────▼─────┐          ┌─────▼─────┐                       │ jobs.js│
      │    │  keyword  │          │   ranker  │                       └───┬───┘
      │    │  engine   │          │  (Node)   │                           │
      │    │  (legacy) │          │   cli.js  │ ◄── select/simulate/eval  │
      │    └─────┬─────┘          │  store.js │      / node --test        │
      │          │               └─────┬─────┘                           │
      │   ┌──────▼──────┐       ┌──────┴──────┐                          ▼
      │   │  apply_editor │   │   embedder.js   │                   localhost:4873
      │   │   (LLM)      │   │   bge-micro-v2  │                       ┌────┴────┐
      │   └──────┬──────┘   └─────────────────┘                   ┌──▼──┐  ┌──▼──┐
      │   ┌──────▼──────┐                                       │Electron│  │Obsidian│
      │   │   db.py     │                                       │ main.cjs│  │ iframe│
      │   │  append_brief │                                  └────┬─────┘ └──┬────┘
      │   └─────────────┘                                          │          │
      └────────────────────────────────────────────────────────────┘          │
                                                                              ▼
                                                                       http://127.0.0.1:4873/
```

Key design principles:

- **One database, many writers/readers.** Python (`src/db.py`), Node (`server/lib/queries.js`), and the ranker
  (`ranker/store.js`) all open `schema.sql` on connect (every statement is idempotent). SQLite WAL mode is used;
  `daily_brief.db` is gitignored.
- **CLI stdout = JSON, stderr = logs.** The ranker CLI writes JSON to stdout so Python can `json.loads()` it;
  diagnostics/warnings go to stderr.
- **LR engine is the default going forward.** The keyword engine remains as a fallback and for A/B comparison.
- **Same-day regeneration supersedes.** Regenerating on the same day flips the previous brief's `counted` to `0`
  and carries like/save marks forward by `item_id`.

---

## Major Components

### Python side (`src/`)

| File | Role |
|------|------|
| `brief.py` | Orchestrator: fetch → classify → upsert → select → LLM edit → append_brief. Engine switch (`--engine`). |
| `selection.py` | Legacy keyword engine: epsilon-greedy + soft staleness per desk. |
| `db.py` | SQLite layer: `connect`, `upsert_pool`, `append_brief`, `load_pool`, `same_day_counts`, etc. |
| `agent.py` | LLM chat loop, JSON salvage, editor (`build_user_message`, `apply_editor`). |
| `util.py` | Shared logging/warnings state (`log`, `warn`). |
| `fetch/` | Fetching subsystem (`fetcher.py`, `semanticscholar.py`, `hn.py`, …). |
| `migrate_to_sqlite.py` | One-off migration from `state.json` + edition dirs. |

### Node server side (`server/`)

| File | Role |
|------|------|
| `index.js` | HTTP server on `http://127.0.0.1:4873`. Exits 0 if already running. Spawns `src/brief.py` to generate. |
| `app.js` | Route handlers: `/api/health`, `/api/briefs`, `/api/job`, `/api/generate`, `/api/shutdown`, `/api/stories/<id>/feedback`, `/api/export/training.jsonl`. |
| `lib/queries.js` | `openDb` + all SQL (shared with Python via `schema.sql`). |
| `lib/render.js` | HTML/Tailwind rendering; brief dropdown lists `meta.engine`. |
| `lib/jobs.js` | Background jobs (feed refresh, auto-shutdown); watches `brief.py` log output for "brief generation done". |
| `public/client.js` | Like/save persistence, Generate + logs, theme, embed bridge. |
| `templates/*.html` | Tailwind-classed layout (page, lead, story, tag, badge, why). |

### Ranker side (`ranker/`)

| File | Role |
|------|------|
| `cli.js` | CLI entry: `embed` / `refit` / `select` / `simulate` / `eval` / `inspect`. stdout=JSON, stderr=logs. |
| `store.js` | `node:sqlite` wrapper; prepared statements for embeddings, training rows, ranker_state. |
| `pipeline.js` | `ensureEmbeddings`, `ensureFitted`, `prepareCandidates`, `evalModel`. |
| `embedder.js` | `@xenova/transformers` wrapper for `TaylorAI/bge-micro-v2` (384-d). |
| `vec.js` | Vector helpers: dot, normalize, Float32Array ↔ Uint8Array (SQLite BLOB). |
| `agglo.js` | Ward agglomerative clustering + perfect-sample stop rule + weighted medoid. |
| `interests.js` | Build interests from perfect + liked items; serialize/hydrate. |
| `features.js` | Feature registry (`bias`, `type`, `author`, `medoid`) + `encode()`. |
| `model.js` | `SparseBayesLogReg` + `auc` / `logLoss`. |
| `trainer.js` | Cross-fitted training set (leak fix), chronological split. |
| `sampler.js` | `selectBrief`, `value`, `draw`, `mulberry32` RNG. |
| `simulate.js` | Ephemeral Monte-Carlo preview; `--set` overrides. |

---

## Major Call Paths

### Path A: Full brief generation (default)

```
python src/brief.py
  │
  ├─► fetch_all()                 fetch RSS/arXiv/HN/etc. (HTTP cache: ~/.cache/daily_brief, 6 h TTL)
  ├─► classify()                  keyword → subtopic + desk + rel  (off-topic items dropped)
  ├─► db.upsert_pool()            candidate_pool upsert + item_meta authors
  ├─► db.prune_pool()             drop items older than pool.max_age_days
  ├─► SELECTION (engine = config.ranker.engine)
  │     ├─ keyword: sel.pick_desk / sel.pick_reserves  (Python, selection.py)
  │     └─ lr: node ranker/cli.js select               (Node ranker, stdout JSON)
  │           → embed (ensureEmbeddings)                bge-micro-v2 on title+snippet
  │           → refit (ensureFitted)                    interests + cross-fitted Bayes LR
  │           → prepareCandidates                       encode features, model.p
  │           → selectBrief                             round-robin core clusters + epsilon-greedy
  ├─► apply_editor()              LLM edits/summaries (OpenRouter) or raw items (--no-llm)
  └─► db.append_brief()           single atomic append: briefs + stories; carry forward likes
```

### Path B: Ranker CLI (standalone)

```
node ranker/cli.js embed
  └─► ensureEmbeddings            missingEmbeddings SQL → embedTexts → INSERT embeddings
                                  perfect samples as 'ps:<id>'; prune orphaned embeddings

node ranker/cli.js refit [--force]
  └─► ensureEmbeddings + ensureFitted
        fitKey = SHA1([perfect, likedIds, trainingRows, config sections, ENCODING_VERSION])
        cache hit → hydrate interests + model from ranker_state
        cache miss → build interests (Ward + perfect-sample stop) + cross-fit + fit model
        persist to ranker_state (interests, model, fit_key)
        log diagnostics to stderr: #clusters, stopHeight, size histogram, #examples, #positives

node ranker/cli.js select --date D [--seed N]
  └─► embed + fit-if-stale → prepareCandidates → selectBrief (mulberry32 RNG)
      → stdout: {desk: [{id, mode, p, V, cluster, core}]}

node ranker/cli.js simulate [--runs N] [--set a.b=v]
  └─► ensureFitted(persist=false) + prepareCandidates + simulate()
      → JSON summary (consecutiveJaccard, distinctClusters, topIncluded); NO DB writes

node ranker/cli.js eval [--testFrac F]
  └─► chronoSplit(examples) → fit on train → auc/logLoss on test (prior / keyword-rel / fitted)

node ranker/cli.js inspect
  └─► top 20 ± weights + cluster list with medoid titles
```

### Path C: Background / auto-refresh

```
server/index.js  (alreadyRunning check → start if needed)
  └─► createApp() routes
        /api/generate   → spawn python src/brief.py (watches stderr for "brief generation done")
        /api/job        → job status (queued/running/done/failed)
        /api/health     → { ok: true, name: 'daily-brief' }
        /api/stories/<id>/feedback  → liked/saved toggle → stories + training_examples
        /api/export/training.jsonl  → training_examples as JSONL
```

### Path D: UI (Electron / Obsidian)

Both entry points load `http://127.0.0.1:4873/` and share the same brief + like/save state.

```
Electron (electron/main.cjs)
  └─► ensureServer()  spawn node server/index.js if not healthy
      └─► BrowserWindow.loadURL(ORIGIN + '/')

Obsidian (obsidian/daily-brief.md)
  └─► dataviewjs: spawn node server/index.js if not healthy
      └─► iframe src = ORIGIN + '/?embed=1&theme=...'
          theme sync via MutationObserver + postMessage
          open-url → shell.openExternal
```

---

## Data Flow

1. **Fetch**: `fetch_all()` gathers raw items from RSS/arXiv/HN/API feeds. Each item is deduplicated by 12-hex
   SHA1 prefix of its canonical URL.
2. **Classify**: `classify()` matches keywords → assigns `subtopic`, `desk`, `rel`. Off-topic items are dropped
   (the keyword gate stays even for the LR engine).
3. **Upsert**: `db.upsert_pool()` writes `candidate_pool` rows and `item_meta` (authors survive pool pruning).
4. **Select**: Either the legacy keyword engine (Python) or the LR engine (Node ranker CLI) picks items per desk
   with mode (`greedy`/`explore`/`reserve`).
5. **Edit**: The LLM (`agent.py`) edits/summaries each story; on `--no-llm` raw items are shown.
6. **Persist**: `db.append_brief()` atomically appends one `briefs` row + `stories` rows. Same-day regeneration
   supersedes (`counted=0` on the old row) and carries forward like/save marks.
7. **Serve**: The Node server reads `briefs`/`stories` and renders HTML. Feedback (`/api/stories/<id>/feedback`)
   writes `liked`/`saved` back to `stories`, which feed the ranker's training labels.

---

## Runtime & Concurrency

- **Node ≥ 22.13** required (`node:sqlite` `DatabaseSync`, ESM `import.meta.url`).
- **`@xenova/transformers`** for embeddings (~50 MB ONNX model, cached in `~/.cache/huggingface`).
- **SQLite WAL mode**; `daily_brief.db` is gitignored. Use an absolute `db_file` outside any Syncthing/Obsidian
  Synced vault (WAL files corrupt under file sync).
- **Single writer at a time**: the server spawns `brief.py` as a subprocess; the ranker CLI is also a separate
  process. SQLite's file-level locking plus WAL keeps concurrent readers safe.
- **Port 4873** on `127.0.0.1` only (never a public interface). `index.js` exits 0 if a server is already
  answering `/api/health`.

---

## Related Docs

| Topic | File |
|-------|------|
| Ranker CLI reference, config, algorithm overview | `ranker/README.md` |
| Bayesian LR + Ward clustering model details | `docs/model.md` |
| Electron / Obsidian / Web usage | `docs/interfaces.md` |
| SQLite-based stateful logging | `docs/sqlite-logging.md` |
| Experiments & simulate functionality | `docs/experiments.md` |
| Full tunable configuration | `config.json` (see `ranker` key) |
| Database schema | `schema.sql` |
