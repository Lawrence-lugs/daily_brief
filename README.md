# Daily Brief

A "front page" of research news, regenerated on demand and embedded in Obsidian. Real items are
fetched by Python; a free OpenRouter model only **ranks and summarizes** them. The brief is served
from a local SQLite database by a localhost Node server, and shown in an Electron window or an
Obsidian iframe.

```
daily_brief/
  server/            Node localhost server (index.js, app.js, lib/, public/, templates/)
    index.js         HTTP server on http://127.0.0.1:4873 (spawns python src/brief.py to generate)
    app.js           route handlers (/api/health, /api/briefs, /api/job, /api/generate,
                     /api/shutdown, /api/stories/<id>/feedback, /api/export/training.jsonl)
    lib/             queries.js, render.js, jobs.js, guard.js
    public/client.js like/save persistence, Generate + logs, theme, embed bridge
    templates/*.html Tailwind-classed layout (page, lead, story, tag, ...)
  src/               Python sources
    brief.py         thin orchestrator: pool, classify, LLM edit, CLI (stdlib only)
    selection.py     epsilon-greedy + soft staleness (pure functions) — LEGACY keyword engine
    util.py          shared logging/warnings state
    agent.py         LLM chat loop, JSON salvage, editor
    db.py            SQLite layer (pool, briefs, stories, feedback, training_examples)
    migrate_to_sqlite.py one-off migration from state.json + edition dir
    fetch/           fetching subsystem (fetcher.py, semanticscholar.py, hn.py, ...)
  ranker/            **NEW** Bayesian LR + Ward clustering ranker (Node ESM)
    cli.js           commands: embed, refit, select, simulate, eval, inspect
    store.js         SQLite wrapper (embeddings, training rows, ranker_state)
    pipeline.js      embeddings -> interests -> model -> candidates
    model.js         SparseBayesLogReg: Gaussian prior, cyclic coordinate Newton, probit predictive
    features.js      feature registry (bias, type, author, medoid distances)
    interests.js     perfect samples + liked items -> weighted medoids (Ward cut)
    agglo.js         Ward agglomerative clustering with perfect-sample stop rule
    sampler.js       interest-level round robin + epsilon-greedy + freshness/dedupe
    simulate.js      ephemeral Monte-Carlo preview, --set overrides
    embedder.js      bge-micro-v2 wrapper (@xenova/transformers)
    vec.js           vector helpers (dot, normalize, sqlite blob conversion)
    trainer.js       cross-fitted training set (leak fix), chronological split
    test/ranker.test.js 15 unit tests (node --test)
  config.json        every tunable (db_file, ranker.*, selection.*, llm.*, fetch.*, pool.*)
  sources.json       arXiv queries, RSS feeds, subtopic keyword lists, desk mapping
  prompt_system.md   the editor prompt (interests + rules + JSON schema)
  perfect_samples.json human-curated anchor items (core + side interests)
  tailwind.input.css Tailwind entry file   tailwind.css  compiled output (committed)
  build_css.ps1      one-off Tailwind build (scans server/templates + server/public/client.js)
  daily_brief.db     SQLite database (gitignored; see config.json db_file)
  tests/             unittest suite (test_db.py); test_selection.py (pytest)
  obsidian/daily-brief.md  Obsidian dataviewjs note that embeds the localhost server
  electron/          Electron window (main.cjs) around the same localhost URL
  ~/.config/openrouter.key          API key (outside the vault)
  ~/.cache/daily_brief/             HTTP cache, 6 h TTL (outside the vault)
  ~/.config/tailwind/tailwindcss.exe standalone Tailwind CLI (outside the vault)
```

## Running it

| What | How |
|---|---|
| From a shell (server) | `npm run serve`  → `http://127.0.0.1:4873/` |
| From a shell (Electron app) | `npm run app` → opens a window on the same URL |
| From Obsidian | open `obsidian/daily-brief.md` (dataviewjs iframe; auto-starts the server if needed) |
| No network LLM | `python src/brief.py --no-llm` (raw items, no OpenRouter calls) |
| Reuse the pool | `python src/brief.py --no-fetch` |
| Don't persist state | `python src/brief.py --dry-run` |
| Refresh feeds only | `python src/brief.py --refresh-api-feeds` |
| Ranker CLI | `node ranker/cli.js <command>` (see `ranker/README.md`) |
| Tests | `python -m unittest src/test_db.py`  and  `npm test` |

The Electron window and the Obsidian iframe both load `http://127.0.0.1:4873/`, so they show the **same
brief and the same like/save marks**. The server is started once and reused by every entry point;
closing the Electron window stops only a server that Electron itself started, never a pre-existing one.

## Selection Engines

Two selection engines are available via `config.ranker.engine` or `--engine` flag:

| Engine | Description | Config key |
|---|---|---|
| `keyword` (legacy) | Per-desk epsilon-greedy on keyword `rel` scores, hard type quotas | `selection.*` |
| `lr` (new) | Bayesian logistic regression on embeddings + author + medoid features; Ward-clustering interests; round-robin core clusters + side desk | `ranker.*` |

The LR engine is the default going forward. The keyword engine remains as a fallback and for A/B comparison.

## Database

`daily_brief.db` (path from `config.json` `db_file`) holds:

- `candidate_pool(item_id PK, url, title, snippet, published, source, source_type, subtopic, desk, rel, first_seen, times_shown, rejected, last_shown)` — the persistent item pool.
- `briefs(brief_id PK, date, edition, generated_at, model, llm_requests, counted, rejected_ids, desks, meta)` — one row per generated brief. Exactly one brief per date has `counted = 1` (the one currently displayed); regenerating the same day flips the previous one to `counted = 0` and carries forward like/save marks for matching items.
- `stories(story_id PK, brief_id, item_id, desk, position, headline, blurb, why_care, tags, significance, summarized, url, source, source_type, subtopic, kind, mode, age_days, rel, times_shown_before, liked, saved, liked_at, saved_at)` — the stories in each brief.
- `training_examples(...)` — one row per date+item with features snapshotted at pick time (subtopic, source, source_type, kind, mode, position, age_days, rel, times_shown_before, significance) plus `liked`/`saved` feedback. Exported as JSONL at `/api/export/training.jsonl`.
- **New tables for LR ranker:**
  - `embeddings(item_id PK, model, text_hash, dim, vec BLOB)` — L2-normalised 384-d Float32 vectors (bge-micro-v2). Pool/story items + perfect samples (`ps:<id>`). Never pruned with the pool.
  - `item_meta(item_id PK, authors JSON)` — author lists survive pool pruning (needed to retrain on old stories).
  - `ranker_state(key PK, value, updated_at)` — cached fitted artefacts: `fit_key`, `interests`, `model`.

## Same-day regeneration

Re-running on the same day supersedes that day's previous brief: the old brief's `counted` flips to `0`, the new brief becomes `counted = 1`, and like/save marks are carried over to matching items (by `item_id`). `times_shown` is adjusted so regenerating does not make the day's own stories look "already seen".

## Desktop only

This is a desktop-only tool: it runs a localhost server and an Electron window / Obsidian iframe. There is no mobile support and no GitHub Pages deployment. External links open in the system browser.

## Documentation

- **Architecture & call paths** → `docs/architecture.md`
- **Bayesian LR + Ward clustering model** → `docs/model.md`
- **Electron / Obsidian / Web usage** → `docs/interfaces.md`
- **SQLite-based stateful logging** → `docs/sqlite-logging.md`
- **Experiments & simulate functionality** → `docs/experiments.md`
- **Ranker CLI reference** → `ranker/README.md`

## Simulation Report Generation

The `simulate` package generates HTML comparison reports for engine experiments.
It uses **Jinja2** for templating and **Plotly** for interactive charts.

### Dependencies

```bash
pip install jinja2 plotly
```

Or add to your project's dependency management:
- `jinja2>=3.1.0`
- `plotly>=5.18.0`

The template is at `simulate/templates/report.html.j2` and chart generation is in `simulate/viz/charts.py`.

## Notes

- Tailwind is compiled once with the standalone CLI (`build_css.ps1`); daily runs never rebuild it. Re-run only after adding utility classes to `server/templates/` or `server/public/client.js`.
- `*.db`, `logs/` are gitignored (and should be excluded from any vault sync — SQLite WAL files corrupt under Syncthing/Obsidian Sync). Consider an absolute `db_file` outside the synced vault.
- `state.json`, `issue-history.json` and the day JSONs are archived in `backup/` (pre-migration sources).