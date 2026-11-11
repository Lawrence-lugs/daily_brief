# STATUS.md: Hygiene TODO list

Tracked cleanup items from the codebase hygiene audit. Each item is a TODO until someone starts or finishes it.

## Instructions for agents

- Before starting an item, change its status to `IN PROGRESS` and add your name or session ID under "Notes".
- When an item is finished, change its status to `DONE` and append a note under its "Notes" section describing what changed, the files touched, and how you verified it.
- If you halt an item for any reason (blocked, unclear, out of scope, failed verification), change its status to `HALTED` and append a note under "Notes" explaining why and what remains.
- Do not delete items. Keep history in the notes.
- Do not change the decisions recorded in "Decisions" without asking the maintainer.
- Do not delete or modify the DB backup files listed under "Decisions"; they stay in git with their current names.

Status values: `TODO`, `IN PROGRESS`, `DONE`, `HALTED`.

## Decisions (from maintainer)

- The Docker image runs two services from one image: the server (serves client DB requests) and the scheduler (runs `brief generate` once a day). Both must work.
- `simulate/config/` stays as a separate copy for simulation purposes. Simulation experiments should read from `simulate/config/`.
- `container/config.container.json` is not a separate seed. The container uses `user/defaults/` as the seed, because the settings editor can change these values.
- The seed step copies a default file into the data dir only if the destination does not already exist. A restarted container keeps existing config and must not be overwritten.
- `@xenova/transformers` is not used by this repo. Remove it. The other project does not depend on this `package.json`.
- The DB backups (`daily_brief.db-wal.pre-fts`, `daily_brief.db.backup`, `daily_brief.db.bak_test`, `daily_brief.db.pre-fts`) stay in git with their current names.
- `notes.md` is the maintainer's personal scratch file. Its plans are implemented. Delete it.
- Python test suites stay until their coverage is checked against the Node tests. Port uncovered tests or delete the Python file. Only tests that were never read at runtime may be dropped without porting.
- `.agents/` is archived. No action needed beyond keeping it gitignored.

---

## P0: Blocking

### P0-1. Docker image copies only `user/defaults/`, not all of `user/`
- Status: TODO
- Location: `container/Dockerfile` lines 48–60.
- Problem: runtime imports from `user/` (`server/app.js` lines 9–11, `server/lib/brief.js` lines 19 and 22, `server/lib/config.js` line 16, `ranker/pipeline.js` line 12, `ranker/cli.js` lines 14–15, `electron/main.cjs` line 83). `user/config.js` `loadSchema` reads `user/schema/*.schema.json`, which is not copied. Both the server and the scheduler are expected to fail at startup with `ERR_MODULE_NOT_FOUND`.
- Action: copy the whole `user/` directory (including `user/schema/`) into the image. Keep `user/defaults/` as the seed source.
- Verify: build the image and start both services. Confirm the server responds and the scheduler runs `brief generate`.
- Notes:

### P0-2. Seed behavior on container restart must be preserved
- Status: TODO
- Location: `user/config.js` lines 34–45 (`seedDataDir` copies only when `!existsSync(dst)`); `user/datadir.js` line 25 (`seedDataDir`, a separate function with the same name).
- Problem: the maintainer requires that a restarted container keeps its existing `/app/config.json` and data-dir config. Current code does this for `user/config.js`. Confirm the same holds for the `user/datadir.js` variant that the server actually calls.
- Action: confirm which `seedDataDir` the container runs. Add a test or manual check that restart does not overwrite an existing config file.
- Verify: start the container, change a setting through the editor, restart, confirm the change persists.
- Notes:

---

## P1: Container config cleanup

### P1-1. Remove the root config copies from the image
- Status: TODO
- Location: `container/Dockerfile` line 57 (`container/config.container.json` → `./config.json`), line 59 (`container/defaults/perfect_samples.json` → `./perfect_samples.json`).
- Problem: nothing reads these root paths. Runtime config comes from the data dir, seeded from `user/defaults/`.
- Action: remove the COPY lines. Keep `user/defaults/` as the seed.
- Verify: grep for `config.json` and `perfect_samples.json` path reads, confirm none depend on the root copies.
- Notes:

### P1-2. Decide the fate of `container/config.container.json` and `container/defaults/perfect_samples.json`
- Status: TODO
- Location: `container/config.container.json` (SHA256 FBAB6592…, differs from `user/defaults/config.json`, SHA256 192EBA31…); `container/defaults/perfect_samples.json` (identical to `user/defaults/perfect_samples.json`).
- Problem: the maintainer says the lab config is intentionally different. Since the container now seeds from `user/defaults/`, this file is unused.
- Action (needs maintainer decision before deleting): confirm whether the lab values should be moved into `user/defaults/config.json`, or whether the lab deployment should be configured through the settings editor. Only then delete the container copies.
- Verify: diff the two config files and list every key that differs.
- Notes:

---

## P2: Dependencies

### P2-1. Remove `@xenova/transformers` from `package.json`
- Status: TODO
- Location: `package.json` line 30; `package-lock.json` (entries at lines 12 and 1408–1410 and related).
- Problem: no source file in this repo imports it. The embedder uses `@huggingface/transformers` (`ranker/embedder.js` line 2). The `Xenova/…` strings in `ranker/embedder.js` line 13 are Hugging Face model IDs, not the npm package.
- Action: remove the dependency and regenerate the lockfile with `npm install` (lockfile change only).
- Verify: grep for `xenova` (should match only model IDs). Run `npm test` and the embedder test.
- Notes:

### P2-2. Remove the duplicate `playwright` devDependency
- Status: TODO
- Location: `package.json` lines 21–34 (both `@playwright/test` and `playwright` at ^1.65.0).
- Problem: only `@playwright/test` is needed for the Playwright runner. Confirm `playwright` is not imported first.
- Action: grep for `from 'playwright'` and `require('playwright')`. If none, remove it.
- Verify: `npm run test:e2e` still runs.
- Notes:

### P2-3. Check `bootstrap-icons` and `jedison` npm dependencies
- Status: TODO
- Location: `package.json` (both listed). Runtime uses vendored copies in `server/public/vendor/bootstrap-icons/` and `server/public/vendor/jedison.umd.js`.
- Problem: neither package is imported at runtime. They may be the source for the vendored copies.
- Action: check whether the vendored files match the npm versions. If the npm packages are only a source for refreshing vendor files, document that. Otherwise remove them.
- Verify: compare versions and file hashes.
- Notes:

### P2-4. Investigate `onnxruntime-common` as a direct dependency
- Status: TODO
- Location: `package.json` (direct entry ^1.30.0); lockfile shows nested versions 1.30.0, 1.31.x, 1.14.0. `ranker/test/onnxruntime_tensor.test.js` line 4 mentions the nested 1.30.0 copy.
- Problem: no direct import in source. The direct entry may be needed to pin the nested copy the test depends on.
- Action: check whether removing the direct entry changes the resolved version the test uses. Keep it only if needed, and add a comment saying why.
- Verify: run `ranker/test/onnxruntime_tensor.test.js` before and after.
- Notes:

---

## P3: Stale code and tests

### P3-1. Delete the orphan `src/` directory
- Status: TODO
- Location: `src/test_db.py`, `src/test_progress.py`, `src/__pycache__/`. The `Dockerfile` line 48 `COPY src/` line should go too.
- Problem: both test files import modules that no longer exist in git (`db`, `fetch.fetcher`, `progress`). They cannot run.
- Action: do P3-4 coverage check first. Then delete. Remove the `Dockerfile` COPY line.
- Verify: `docker build` still succeeds after the COPY line is removed.
- Notes:

### P3-2. Python test coverage map against Node modules
- Status: TODO
- Location: `tests/` (`conftest.py`, `test_brief.py`, `test_agent.py`, `test_selection.py`), `simulate/tests/` (`test_config`, `test_engine`, `test_keyword_engine`, `test_metrics`, `test_pool`, `test_reporter`, `test_runner`, `conftest`), `src/` (see P3-1).
- Problem: `tests/` imports removed modules (`brief`, `fetch`) and cannot run. The `simulate/tests/` suite is for simulation code, which is still live, so it should be kept if it runs.
- Action: for each Python test, record which Node module (if any) covers the same behavior. List gaps. Port the uncovered tests to Node, or delete the Python file if coverage is confirmed. `simulate/tests/` is kept unless it is confirmed to be broken.
- Verify: run `simulate/tests/` to see if it passes.
- Notes:

### P3-3. Test script does not run all Node tests
- Status: TODO
- Location: `package.json` `test` script (runs `server/test/*.test.js` only). Not run: `ranker/test/*.test.js`, `ranker/ranker.test.js`.
- Problem: those tests never run in `npm test` or CI.
- Action: extend the script or add a second script, and confirm each file passes.
- Verify: run the new script. Fix or halt on failures.
- Notes:

### P3-4. Broken tools: `tools/check_fts.py` and `tools/profile_brief.py`
- Status: TODO
- Location: `tools/check_fts.py` line 3 (`from src import db`); `tools/profile_brief.py` lines 5, 9, 17, 36, 256 (runs `python src/brief.py`).
- Problem: both reference removed Python modules.
- Action: delete, or port to the Node modules if still needed. Ask maintainer if unsure.
- Verify: grep for references to these tools in docs.
- Notes:

### P3-5. `tools/render_node.js` and `tools/migrate_perfect_samples.js`
- Status: TODO
- Location: `tools/render_node.js` (imports `server/lib/render.js`; no other references found); `tools/migrate_perfect_samples.js` (one-off migration).
- Action: confirm the migration is complete, then delete. For `render_node.js`, check docs and delete if unused.
- Verify: grep docs for each name.
- Notes:

### P3-6. Unused exports in `user/config.js`
- Status: TODO
- Location: `user/config.js` line 26 (`getSchemaDir`), line 27 (`getRepoRoot`), line 29 (`listEditableFiles`), line 75 (`invalidateSchemaCache`).
- Problem: no call sites found in the repo. `AGENTS.md` line 16 documents `listEditableFiles`.
- Action: check the settings editor and `user/routes.js` for dynamic use. Remove unused exports and update `AGENTS.md` if needed.
- Verify: run `server/test` and the settings e2e test.
- Notes:

### P3-7. Remove unused export `insertBrief`
- Status: TODO
- Location: `server/lib/db.js` line 234 (called only inside `appendBrief`, line 264).
- Action: remove the `export` keyword.
- Verify: `npm test`.
- Notes:

### P3-8. Stale `BRIEF_NODE` reference
- Status: TODO
- Location: `ranker/PLAN.md` line 128 (only mention; no code reads it).
- Action: handled with P5-3 when `ranker/PLAN.md` is archived or deleted.
- Notes:

### P3-9. Stale comment in `server/test/db.test.js`
- Status: TODO
- Location: `server/test/db.test.js` lines 12–13 ("pre-existing bug" in `db.connect()`). `server/test/brief_generation.test.js` line 75 and `brief_generation_regression.test.js` line 35 call `connect()`.
- Action: run the tests. If `connect()` works, remove the comment. If not, fix the bug.
- Verify: `npm test`.
- Notes:

### P3-10. Duplicate config modules
- Status: TODO
- Location: `server/lib/config.js` (line 16 imports `user/config.js`; `loadDesksConfig`) and `user/config.js`.
- Problem: two modules load config. Both are imported by `server/lib/brief.js` (lines 18 and 19).
- Action: decide whether the responsibilities should merge. Record the decision here before changing code.
- Verify: `npm test`.
- Notes:

### P3-11. Two parallel DB access layers
- Status: TODO
- Location: `server/lib/db.js` (writer, schema via `SCHEMA_FILE` line 14), `server/lib/queries.js` (reader, `openDb` line 7, `makeQueries` line 41, imported by `server/app.js` line 4).
- Problem: both load the same schema.
- Action: decide whether to share the schema loading. Record the decision before changing code.
- Verify: `npm test` and the server e2e tests.
- Notes:

---

## P4: Docs and comments

### P4-1. Stale Python references in docs
- Status: TODO
- Location: `README.md` lines 17, 48, 58–60, 74 (line 58–60 is self-contradictory). `docs/architecture.md` lines 12, 32, 59, 72–89, 121, 175. `docs/interfaces.md` line 23. `docs/sqlite-logging.md` lines 5, 157, 164. `docs/experiments.md` lines 169, 172. `docs/model.md` lines 6, 46. `ranker/README.md` lines 3, 242. `ranker/debuglog.js` lines 3, 72.
- Problem: they describe a Python server that spawns `src/brief.py`. The server now runs in-process.
- Action: rewrite each to describe the current Node architecture.
- Verify: grep for `src/brief.py`, `src/db.py`, `src/selection.py`, `spawns python`, `python src/`.
- Notes:

### P4-2. Stale `src/` references in code comments
- Status: TODO
- Location: `server/lib/util.js` line 1 (`port of src/util.py`), `server/lib/selection.js` line 1 (`port of src/selection.js`, file never existed), `simulate/engines/keyword_engine.py` line 9 (`Defaults from src/selection.py`), `schema.sql` line 1 (`Opened by BOTH python (src/db.py) and node`).
- Action: update each comment to match the current code.
- Verify: grep for `src/`.
- Notes:

### P4-3. Simulation experiments should read `simulate/config/`
- Status: TODO
- Location: `simulate/experiments/clustering_ablation.py` line 55, `ablation_runner.py` line 37, `lr_dendrogram.py` line 50, `monte_carlo_runner.py` line 36, `sacred_runner.py` line 91, `sweep_runner.py` line 36 (all hard-code `user/defaults/perfect_samples.json`).
- Action: change each path to `simulate/config/perfect_samples.json`. Check the other `simulate/config/` files as well.
- Verify: run the clustering ablation with `--unobserved` and confirm it loads.
- Notes:

### P4-4. Stale `AGENTS.md` claims
- Status: TODO
- Location: `AGENTS.md` line 16 (`listEditableFiles`); the simulate CLI command section.
- Action: verify each command listed against `simulate/cli.py` and `ranker/cli.js`, and update.
- Verify: run each documented command with `--help` or a dry run.
- Notes:

### P4-5. Absolute Windows path in archived docs
- Status: TODO
- Location: `docs/experiments/archive/embedding_model_comparison_*.md` line 6 (`C:\Users\lafqu\...`).
- Action: replace with a relative path.
- Verify: grep for `C:\\Users`.
- Notes:

---

## P5: Git hygiene

### P5-1. Fix the `.gitignore` `.coverage` line
- Status: TODO
- Location: `.gitignore`, the malformed line `. c o v e r a g e` (between `.server.pid` and `docs/experiments/**/*.html`).
- Problem: the spaced characters mean `.coverage` is not ignored. `.coverage` is currently tracked.
- Action: replace with `.coverage`. Then remove the tracked file with `git rm --cached .coverage` (requires maintainer approval, since it changes the index).
- Verify: `git check-ignore .coverage`.
- Notes:

### P5-2. Remove tracked Syncthing conflict copy
- Status: TODO
- Location: `simulate/cli.sync-conflict-20261031-072425-ZPZKKGU.py`.
- Action: diff against `simulate/cli.py`, then `git rm`.
- Verify: diff output recorded in notes.
- Notes:

### P5-3. Archive or delete stale plans
- Status: TODO
- Location: `PLAN-ONE-LLM-CALL.md` (implemented in commit 1175b8f), `ranker/PLAN.md` (refers to Python `src/`; line 128 has `BRIEF_NODE`; line 271 has `npm i @xenova/transformers`), `notes.md` (maintainer scratch; plans implemented).
- Action: delete `notes.md` and `PLAN-ONE-LLM-CALL.md`. Move `ranker/PLAN.md` to `docs/experiments/archive/` or delete it.
- Verify: grep for links to these files in docs.
- Notes:

### P5-4. Numbered notebook copies
- Status: TODO
- Location: `docs/experiments/clustering_ablation.quarto_ipynb` and `_1` through `_9` (tracked).
- Action: keep the latest version. Confirm which is current, then `git rm` the rest.
- Verify: diff the copies. Record the decision in notes.
- Notes:

### P5-5. Archive JSON duplicates
- Status: TODO
- Location: `docs/experiments/archive/comparison_2026-10-29_10seeds.json` and `comparison_2026-10-29_20261101_115210.json`.
- Action: diff them. If they are duplicates, remove one. Record which one was kept.
- Verify: diff output in notes.
- Notes:

### P5-6. Tracked `test-results/.last-run.json`
- Status: TODO
- Location: `test-results/.last-run.json`.
- Action: `git rm --cached`, and add `test-results/` to `.gitignore`.
- Verify: `git status` after the change.
- Notes:

### P5-7. Untracked debris (no git change needed)
- Status: TODO
- Location: `backup/state.json`, `logs/`, root `__pycache__/`, `src/__pycache__/`, `.server.pid`, `.pytest_cache/`.
- Action: delete when no longer needed. These are gitignored.
- Verify: confirm the files are gitignored.
- Notes:

### P5-8. Playwright config is hard-coded to Windows
- Status: TODO
- Location: `playwright.config.js` lines 12–29 (`LOCALAPPDATA`, and a hard-coded `chromium-1248` path at line 29).
- Problem: breaks on macOS and Linux, which the release matrix covers.
- Action: use Playwright's default browser resolution, or make the path platform-aware.
- Verify: run `npm run test:e2e` on Windows. Ask the maintainer for macOS or Linux verification.
- Notes:

---

## P6: Documentation for DB backups

### P6-1. Record the DB backup decision in the repo
- Status: TODO
- Location: `.gitignore`.
- Problem: the `*.db` pattern does not match `daily_brief.db-wal.pre-fts`, `daily_brief.db.backup`, `daily_brief.db.bak_test`, or `daily_brief.db.pre-fts`. These are tracked on purpose.
- Action: add a comment in `.gitignore` saying the backup files are intentionally tracked. Do not change their names. Do not add more backups without maintainer approval.
- Verify: `git ls-files` still lists the four files.
- Notes:
