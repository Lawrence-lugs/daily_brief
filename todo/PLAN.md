# Daily brief: SQLite + localhost server — implementation plan

Project root below = `98-Scripts/daily_brief/`. Deliverables from this bundle are copied into it unchanged
unless a phase says otherwise. **Each phase = one subagent, fresh context, < 100K tokens.**
General rules for every subagent: do not refactor code outside the listed files; do not "improve" the
provided code (it is tested — report problems instead); stop and report if an acceptance check fails twice.

Already verified in the sandbox (Python 3.12, Node 22.22): `python -m unittest src/test_db.py` (7 pass),
`node --test server/test/*.test.js` (6 pass), migration script on synthetic data, JobRunner with a fake script.
NOT verified (no deps/GUI available): the new `brief.py` end to end, Tailwind dark mode, Electron, Obsidian iframe.

| # | Phase | Est. tokens | Depends on |
|---|-------|-------------|------------|
| 0 | Prep, copy files, backups, run provided tests | ~10K | – |
| 1 | Migrate real data, verify counts | ~15K | 0 |
| 2 | Switch `brief.py` to the DB, fix Python tests | ~30K | 1 |
| 3 | Serve + render parity + Tailwind rebuild | ~40K | 2 |
| 4 | Generate flow end to end | ~25K | 3 |
| 5 | Electron window + Obsidian embed | ~25K | 4 |
| 6 | Cleanup + docs | ~20K | 5 |

## Phase 0 — Prep (no behaviour change)
1. `git status` clean? Commit or stash. Copy `state.json`, `<edition_dir>/` (incl. `issue-history.json`, `*.json`) to `backup/`.
2. `node -v` must be >= 22.13 (node:sqlite without flags). If lower: stop and report.
3. Copy in: `schema.sql`, `package.json`, `server/**`, `electron/**`, `src/db.py`, `src/test_db.py`, `src/migrate_to_sqlite.py`, `obsidian/daily-brief.md` (kept aside, not used yet). **Do NOT copy `src/brief.py` yet.**
4. Add to `config.json`: `"db_file": "daily_brief.db", "debug_dir": "logs"`.
5. Ignore `*.db`, `*.db-wal`, `*.db-shm`, `logs/` in git AND in any vault sync (Obsidian Sync/Syncthing corrupt WAL databases). Strongly consider setting `db_file` to an absolute path outside the synced vault (supported: `PROJECT_ROOT / absolute` resolves to the absolute path).
**Accept:** `python -m unittest src/test_db.py` OK; `npm test` OK; old `python src/brief.py --no-llm --no-fetch --dry-run` still works.

## Phase 1 — Migrate real data
1. `python src/migrate_to_sqlite.py --edition-dir <edition_dir>` (use the same dir the dataviewjs `DIR` points at, e.g. `05-for-agents/daily-brief`).
2. Verify with sqlite3 (all must hold):
   - `SELECT COUNT(*) FROM candidate_pool` == number of items in `state.json`.
   - `SELECT COUNT(*) FROM briefs` == number of entries in `issue-history.json` that have `desks`.
   - Per date: exactly one brief with `counted=1`.
   - `SELECT SUM(liked) FROM training_examples` == number of liked stories across the day JSON files (modulo items not in any brief).
   - `SELECT times_shown FROM candidate_pool` unchanged vs state.json for 5 random ids.
3. Re-running without `--force` must refuse (rc=1).
**Accept:** the checks above, pasted into the report. If a legacy story is missing a NOT NULL field (`url`, `source`, `subtopic`), patch only `migrate_to_sqlite.py` with `.get(..., default)`.

## Phase 2 — Switch brief.py
1. `git mv src/brief.py src/brief_old.py` (keep temporarily for Phase 3 parity checks; it must not be imported by anything), then copy in the new `src/brief.py`.
2. `grep -rn "state.json\|STATE_FILE\|merge_pool\|render_page\|load_day_state\|issue-history\|rollback_same_day" src tests` — every hit outside `brief_old.py`/`migrate_to_sqlite.py` must be fixed or the test deleted if it only tested removed code. Keep `test_selection.py` untouched. `conftest.py` monkeypatches `brief.CACHE` — it still exists.
3. `fetch/fetcher.py` does `from brief import Fetcher, CACHE` — verify imports still resolve (`python -c "import brief"` from `src/`).
4. Runs, in order, checking the DB each time:
   `--no-llm --no-fetch --dry-run` (no rows written) → `--no-llm --no-fetch` (1 new brief, `counted=1`) → same again (2 briefs, only the newest `counted=1`, `times_shown` identical to after run 1) → one full run with the LLM → `python src/brief.py --refresh-api-feeds` (exits 0, pool count does not shrink).
**Accept:** all runs rc=0; the log contains `brief generation done: brief_id=`; tests pass.

## Phase 3 — Server, render parity, Tailwind
1. `node server/index.js` → `http://127.0.0.1:4873/` shows the latest migrated brief.
2. Parity script `tools/parity.py` (write it): import `brief_old`, for the latest brief load stories from SQLite, build the dicts `render_story` expects (`id`=item_id, tags list, `age_days`, `summarized`, `kind`), render with Python; fetch the same stories via `GET /api/briefs/<id>` and render with `makeRenderer().renderStory` (tiny node script). Normalise `data-story-id="..."` and whitespace, then compare. Expected diff: none (the only intended change is the id attribute value). Known pre-existing oddity: `lead.html` puts a bookmark emoji in `.like-mark`, `story.html` does not — leave as is.
3. Tailwind: `build_css.ps1` must scan `server/templates/*.html` and `server/public/client.js` (the old `src/templates` can stay until Phase 6). Rebuild `tailwind.css`.
4. Dark mode: open `tailwind.config`; if `darkMode` is not `'class'`, set it (the old dataviewjs toggled `html.dark`, client.js does the same). Check `/?theme=dark` and `/?theme=light` visually.
5. In a browser: like + save a story, reload (state persists), `sqlite3 ... "SELECT story_id,liked,saved FROM stories WHERE liked OR saved"` shows it; `curl http://127.0.0.1:4873/api/export/training.jsonl | head -3`.
**Accept:** parity script prints `0 differences`; persistence check passes; no console errors.

## Phase 4 — Generation flow
1. Click Regenerate: log popup streams; page navigates to the new brief when done; likes from the previous same-day brief are carried over.
2. Double click → second request returns 409, UI keeps polling the running job.
3. Failure path: `BRIEF_PYTHON=nonexistent node server/index.js` → status shows "cannot start nonexistent…" and the button re-enables.
4. Kill the server mid-job: restart must not leave a stuck state (job state is in-memory by design).
**Accept:** the four scenarios behave as stated; report any deviation with the log text.

## Phase 5 — Electron + Obsidian
1. `npm i -D electron` (pin whatever installs). `npm run app` opens the window; closing it stops a server it started itself, but leaves a pre-existing server running. External links open in the system browser.
2. Obsidian: replace the old note content with `obsidian/daily-brief.md`. Check: server auto-starts, iframe loads, Generate works, links open externally, toggling Obsidian light/dark updates the iframe.
3. If Obsidian refuses to frame `http://127.0.0.1`: report (do not hack around it); fallback is a button that calls `shell.openExternal(ORIGIN)`.
**Accept:** both entry points show the same brief and the same like/save marks.

## Phase 6 — Cleanup + docs
1. Delete `src/brief_old.py`, `src/templates/`, `tools/parity.py`; archive `state.json`, `issue-history.json`, day JSONs into `backup/` (already copied in Phase 0).
2. Remove `--re-render`/`--out` mentions from README; document: how to start (`npm run serve`, `npm run app`, Obsidian note), DB location, tables, `training_examples` view, `/api/export/training.jsonl`, same-day regeneration semantics, "desktop only (no mobile, no GitHub Pages)".
3. Final: full test run (`unittest`, `npm test`).
**Accept:** repo has exactly one persistence mechanism; README matches reality.

## Later (not in this plan): recommender
Training rows come from `training_examples` (one row per date+item; features snapshotted at pick time:
subtopic, source, source_type, kind, mode, position, age_days, rel, times_shown_before, significance).
Caveat: a story that was shown and not clicked is a weak negative, not a true one (no impression/dwell logging).
If you want proper counterfactual training, add an `events` table later; deliberately omitted to keep the 3-table design.
