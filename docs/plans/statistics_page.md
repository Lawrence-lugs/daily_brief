# Plan: Statistics page

Status: approved, not started.
Audience: an executing agent. Follow steps in order. Each step lists the files to touch, what to do, and how to check it. If a step says **VERIFY FIRST**, locate the thing named before writing code, and record what you found in a comment at the top of your change or in your summary. Do not guess names.

## Decisions (final, do not revisit)

1. The new sidebar button opens a page at route `/statistics`.
2. The page shows a 2x2 grid of four cards. Each card has a title, a body, a centred **Generate** button, and a footer.
3. Card results persist to disk, so they survive a server restart.
4. Feed audit code moves from `simulate/experiments/audit_feeds.mjs` to `simulate/experiments/audit_feeds.mjs`. The old folder is deleted after the move.
5. The clustering scatter is a **UMAP** scatter (not "PCM"). It uses **all embedded items**: candidate pool, liked items, and perfect samples. Groups are hidden or shown via Plotly legend clicks, not via code.
6. p and V are **not stored** in the DB for candidate items. They are only stored for chosen stories. The p/V card must recompute them from the ranker.
7. **Auth boundary.** The statistics page is visible to every user, but generation is expensive and must be restricted. All generate calls live under the path prefix `/api/restricted/`. Traefik will force authentication on that prefix. The app must not add its own auth. Read-only calls (`GET`) stay public and live under `/api/stats/`.
   - Generate endpoint: `POST /api/restricted/stats/:cardId/generate`
   - Read endpoint: `GET /api/stats/:cardId`
   - Do not expose any other mutating stats endpoint. Do not put generate logic on the `/api/stats/` prefix.
   - Make the prefix a single constant `RESTRICTED_PREFIX = '/api/restricted'` in `server/stats/index.js` so it is easy to change. Use it when building the client URL too.

## Ground rules for the executor

- Match the style of the surrounding code. Do not reformat unrelated files.
- Do not add comments that only restate code. Add comments only where behaviour is non-obvious.
- Do not change `user/defaults/*.json`. They are read-only inputs.
- Do not commit. Leave changes in the working tree.
- After each phase, run the phase's checks. If a check fails, fix it before moving on.
- If something in this plan contradicts the code, stop and write the contradiction in your summary. Do not silently work around it.

## Key existing files (already known)

| Purpose | Path |
|---|---|
| Main page template, sidebar markup | `server/templates/page.html` |
| Sidebar behaviour | `server/public/sidebar.js` |
| Sidebar styles | `server/public/sidebar.css` |
| Sidebar jsdom test | `server/test/sidebar.test.js` |
| E2E tests | `tests/e2e/*.test.js` (settings example: `tests/e2e/settings.test.js`) |
| Config routes pattern | `user/routes.js` |
| Ranker engine | `ranker/` (`pipeline.js`, `store.js`, `interests.js`, `model.js`, `embedder.js`) |
| Sacred model-eval query | `simulate/experiments/sacred_runner.py` function `_load_model_eval(db_path, date)` |
| Clustering reference | `C:\Users\lafqu\workspace\01_Projects\clustering\src\clustering\agglo_cluster.py` (read-only reference, do not edit) |
| Feed audit script (to move) | `simulate/experiments/audit_feeds.mjs` |
| DB | `daily_brief.db` at project root |

## Phase 0: Discovery (no code changes)

Do these first and write the answers into a scratch note at `docs/plans/statistics_page.notes.md`.

- **VERIFY FIRST A:** How does the server register routes? Find the route for `/settings` or the settings page. Grep for `settings` under `server/`. Record: the file that registers routes, and how a page template is served.
- **VERIFY FIRST B:** How does the sidebar Settings button look? Grep for `settings` in `server/templates/page.html`. Copy its exact markup shape for the new button.
- **VERIFY FIRST C:** Where are embeddings stored? Grep `embedding` in `daily_brief.db` schema (`ranker/schema.sql` or similar). Record table name, columns, and how to get the vector for an item id. Record also the embedding slot/tag name used by ranker.
- **VERIFY FIRST D:** Which ranker function computes p and V for candidates? Grep `\bp\b|\bV\b|score` in `ranker/*.js`. Look for the function that returns per-item probability `p` and value `V` (or whatever the ranker calls them). Record function name, module path, and its inputs. If p and V cannot be recomputed without running the full pipeline, record that too.
- **VERIFY FIRST E:** Where is the candidate pool read? Grep `getPool` in `ranker/store.js`. Record the function and its return shape.
- **VERIFY FIRST F:** Where are liked and perfect-sample ids? Grep `getLikedIds` in `ranker/store.js` and read `user/defaults/perfect_samples.json` shape.
- **VERIFY FIRST G:** Does the repo have a Python environment for the server? Check `requirements*.txt`, `pyproject.toml`, or a `.venv`. Confirm `scikit-learn`, `numpy`, and `plotly` (or plotly.js via CDN) are available. If Python is not part of the server runtime, see Phase 5 fallback.
- **VERIFY FIRST H:** How does the server currently call Python, if it does at all? Grep `spawn|child_process|python` under `server/`. If none, Phase 5 uses a Python subprocess script.
- Check how Plotly is loaded on the existing pages. Grep `plotly` under `server/` and `docs/`. Reuse that loading method. If none, load plotly.js from the same CDN style used by other vendored assets.

Checks: the notes file lists an answer for A–H. No source changes yet.

## Phase 1: Move feed audit into simulate/experiments

1. Create `simulate/experiments/audit_feeds.mjs` with the contents of `simulate/experiments/audit_feeds.mjs`.
2. In the new file, change `const ROOT = join(import.meta.dirname, '..', '..');` to `const ROOT = join(import.meta.dirname, '..', '..');`. The depth is unchanged because both locations are two levels below the project root (`experiments/feeds/` and `simulate/experiments/`). Verify this: `simulate/experiments` is two levels deep. Keep the value as is, then confirm by running step 4.
3. Refactor for reuse. Keep the CLI behaviour. Make these exports:
   - `export async function auditFeeds({ log = false } = {})` returns an array of result objects with fields: `name, url, type, default_subtopic, status, ok, feedValid, itemCount, blocked, blockReason, error`.
   - Move the existing `run()` body into `auditFeeds`, but make the `console.log` calls conditional on `log`. Keep `printTable` and `printVerdict` for the CLI path.
   - At the bottom: `if (import.meta.url === pathToFileURL(process.argv[1]).href) { run().catch(...) }` so running the file directly still prints the table. Import `pathToFileURL` from `node:url`.
4. Delete `simulate/experiments/audit_feeds.mjs`. Delete `experiments/feeds/` if it is empty after that. Check for `feeds.mjs` in the same folder first. Do not delete other files. If other files are present, leave them and say so in the summary.
5. Check: `node simulate/experiments/audit_feeds.mjs` prints the table with the same totals as before the move.

## Phase 2: Persistence layer for cards

Create `server/stats/cache.js` (ESM or CJS, match the server's module style per VERIFY FIRST A).

- Storage: one JSON file per card at `<data-dir>/stats/<cardId>.json`. Use the same data-dir resolution as the server's config code (grep `defaultDataDir` in `user/datadir.js`).
- Shape:
  ```json
  { "cardId": "feeds", "generatedAt": "2026-11-12T10:00:00.000Z", "sourceHash": "abc...", "payload": {} }
  ```
- Functions:
  - `readCard(cardId)` returns the stored object or `null`.
  - `writeCard(cardId, {sourceHash, payload})` writes atomically: write `<file>.tmp`, then rename. Set `generatedAt` to now.
  - `isOutdated(stored, currentSourceHash)` returns true if `stored` is null or `stored.sourceHash !== currentSourceHash`.
- Card ids (exact strings): `feeds`, `pv_hist`, `lr_metrics`, `pca_clusters`.

Check: unit test in `server/test/stats-cache.test.js` covering write→read round trip, atomic rename (tmp file gone), and `isOutdated` cases.

## Phase 3: Routes and page shell

### 3a. Route

Add routes following the pattern found in VERIFY FIRST A:

- `GET /statistics` renders the statistics page template.
- `GET /api/stats/:cardId` returns `{ card: <stored or null>, outdated: bool, currentSourceHash }`.
  - `currentSourceHash` is computed by each card's source-hash function (see per-card sections). Compute it on every GET, cheaply.
- `POST /api/restricted/stats/:cardId/generate` runs the card's generator, writes the cache, and returns the new stored object. This path is behind Traefik auth (Decision 7). Build the path from `RESTRICTED_PREFIX`. Do not register this route under `/api/stats/`.
  - Return 404 for unknown `cardId`.
  - Return 409 if the same card is already generating. Track an in-memory `Set` of running card ids.
  - On exception, return 500 with `{error: message}`. Do not write the cache on failure.

### 3b. Sidebar button

In `server/templates/page.html`, add a Statistics button in the sidebar next to Settings. Copy the Settings button markup. Use icon `bi-bar-chart-line` and label `Statistics`, `href="/statistics"`. Make sure the button's id is unique, e.g. `sb-statistics`.

### 3c. Statistics page template

Create the page template next to the existing page templates (VERIFY FIRST A). It must:

- Reuse the sidebar and base layout of the main page. Copy the `<head>` assets and sidebar include from `page.html`.
- Contain a grid container `<div id="stats-grid" class="stats-grid">` with four cards, in this order: `feeds`, `pv_hist`, `lr_metrics`, `pca_clusters`.
- Each card markup:
  ```html
  <section class="stat-card" data-card="feeds">
    <header><h2>Feed health</h2></header>
    <div class="stat-body"></div>
    <footer>
      <span class="stat-meta"></span>
      <span class="stat-outdated" hidden>Outdated</span>
    </footer>
    <div class="stat-action"><button type="button" class="stat-generate">Generate</button></div>
  </section>
  ```
  Card titles: "Feed health", "p / V score histograms", "LR model metrics", "Clustering (UMAP)".
- Put the Generate button in the middle of the card body area when the card is empty. After generation, keep the button at the bottom of the card as "Regenerate".

### 3d. Client script

Create `server/public/statistics.js`. On load:

1. For each `[data-card]`, `fetch('/api/stats/' + id)`.
2. If `card` is null, show the Generate button centred and the body text "Not generated yet".
3. If `card` exists, call the card renderer (see per-card renderers), set the meta to `Generated <local time>`, and show the Outdated badge if `outdated` is true.
4. On Generate click: disable the button, set the body to "Generating…", POST to `/api/restricted/stats/:id/generate`, then re-render. On error, show the error message in the body and re-enable the button. On HTTP 401/403 (auth required), show "Sign-in required to generate" and re-enable the button.

Renderers are functions `renderFeeds(body, payload)`, `renderPvHist(body, payload)`, `renderLrMetrics(body, payload)`, `renderPcaClusters(body, payload)`. Each takes a DOM element and the payload. Keep them in `statistics.js`.

Add `server/public/statistics.css` for `.stats-grid` (CSS grid, two columns at width ≥ 900px, one column below), `.stat-card` (border, padding, rounded corners, flex column), `.stat-action` (flex centre when empty).

Check: page loads with four "Not generated yet" cards. Reload keeps them. Outdated badge appears when you manually change the cache's `sourceHash`.

## Phase 4: Per-card generators

Each generator lives in `server/stats/cards/<cardId>.js` and exports:

- `sourceHash()` returns a string (async allowed).
- `generate()` returns the payload object (async allowed).

Register them in `server/stats/index.js` as a map `{ feeds, pv_hist, lr_metrics, pca_clusters }`. The routes from 3a use this map.

### 4a. feeds

- `sourceHash()`: sha256 of the raw bytes of `user/defaults/sources.json`.
- `generate()`: call `auditFeeds()` from `simulate/experiments/audit_feeds.mjs` (import via relative path from `server/stats/cards/feeds.js`). Return `{ rows, totals: {total, ok, blocked, failed} }`. Here `ok` = `r.ok && r.feedValid`, `blocked` = `r.blocked`, `failed` = `!r.ok && !r.blocked`, matching `printTable`.
- Renderer: a table with columns Status (✅/🚫/❌), HTTP, Items, Block reason, Source. Sort rows so non-OK rows come first. Totals line above the table.
- The audit makes network requests and can take ~15 s per timed-out feed. The POST may take a long time. Set no server-side timeout beyond what `auditFeeds` already applies.

### 4b. pv_hist (p / V histograms)

- **VERIFY FIRST D and E.** Find the ranker's candidate pool reader and the function that scores items for p and V.
- `sourceHash()`: sha256 of the concatenation of `pool_count` and `max(updated_at or id)` from the candidate pool table, plus the hash of `user/defaults/config.json`. Use whatever timestamp column the pool table has (VERIFY). If no timestamp exists, use the count plus a sorted list of ids hashed.
- `generate()`:
  1. Load the candidate pool using the function from VERIFY FIRST E.
  2. Run the ranker's p/V computation for every candidate (VERIFY FIRST D). Do not write these values to the DB.
  3. Return `{ p: number[], V: number[], n: number, pMean, pMedian, vMean, vMedian }`. Round values to 6 decimals to keep the file small.
- Renderer: one Plotly figure with two histograms, `type: 'histogram'`, `opacity: 0.55`, `barmode: 'overlay'`, `xbins: {start: 0, end: 1, size: 0.05}`. Trace names "p" and "V". Caption shows n and the four summary stats.
- Plotly load: reuse the existing method found in VERIFY FIRST H or the Plotly loading pattern on other pages.

### 4c. lr_metrics

- **VERIFY FIRST:** Use `_load_model_eval` logic from `simulate/experiments/sacred_runner.py`. Read it, then reproduce its SQL in Node, or call a small Python script. Pick the Node port unless the Python function is the only source of truth. Port the SQL exactly:
  ```sql
  SELECT embedding_tag, prior_auc, prior_logloss, keyword_auc, keyword_logloss, fitted_auc, fitted_logloss
  FROM model_eval WHERE cutoff_date = ? ORDER BY embedding_tag, created_at DESC
  ```
  Keep only the newest row per `embedding_tag`.
- Which `cutoff_date` to use: the latest `cutoff_date` in `model_eval` (`SELECT MAX(cutoff_date) FROM model_eval`). Report it in the payload.
- `sourceHash()`: sha256 of `MAX(created_at)` and `COUNT(*)` from `model_eval`.
- `generate()` returns `{ cutoffDate, tags: [{ tag, prior: {auc, logLoss}, keyword: {...}, fitted: {...} }] }`. If the table is empty, return `{ cutoffDate: null, tags: [] }` and the renderer shows "No model_eval rows yet".
- Renderer: table with rows prior / keyword / fitted; columns AUC and logLoss per tag. If there are multiple tags, one table per tag, with the tag as heading.

### 4d. pca_clusters

- **VERIFY FIRST C.** Find where embeddings live and how to read them for all items: candidate pool, liked items, perfect samples.
- `sourceHash()`: sha256 of the sorted list of embedded item ids plus the embedding tag.
- `generate()` is implemented in Python (see Phase 5). It returns `{ points: [{id, title, group, cluster, x, y}], centroids: [{cluster, x, y, size}], k, silhouette, explainedVariance: null }`.
  - `group` is one of `pool`, `liked`, `perfect`. An item in several groups gets the first match in that order.
- Renderer: one Plotly scatter per cluster, so the legend toggles groups. Each trace: `mode: 'markers'`, `name: 'cluster <n>'`, hover text = `title + ' (' + group + ')'`. Add a centroid trace with `mode: 'markers+text'`, marker `symbol: 'x'`, size 14, and text labels. Axis titles: `UMAP1` and `UMAP2` (UMAP has no explained-variance ratio). Caption shows k and silhouette.

## Phase 5: Python clustering script

Only needed for `pca_clusters`. Use the Node server to call Python.

1. Create `simulate/experiments/pca_clusters.py` with:
   - `def compute(embeddings, ids, titles, groups, max_k=10) -> dict` returning the payload from 4d.
   - `if __name__ == "__main__":` read a JSON object from stdin with keys `{ids, titles, groups, vectors}`, print the payload as JSON to stdout.
2. Algorithm inside `compute` (follow `agglo_cluster.py` lines 150–176 and 92–101):
   - `X = np.asarray(vectors, float)`; L2-normalize rows (`X / np.linalg.norm(X, axis=1, keepdims=True)`).
   - Silhouette scan for `k` in `2..min(max_k, n-1)` using `AgglomerativeClustering(n_clusters=k, linkage='ward').fit_predict(X)` and `silhouette_score`. Pick the best k.
   - Refit with best k. `labels = agg.labels_`.
   - `pca = PCA(n_components=2).fit(X)`; `Z = pca.transform(X)`.
   - Centroid for each cluster = mean of `Z` rows in PCA space (pseudo-centroid, as in the reference).
   - Require `n >= 3`. If fewer, raise a `ValueError` with a clear message, and the server returns it as an error.
3. In Node, `server/stats/cards/pca_clusters.js`:
   - `generate()` gathers the data (ids, titles, groups, vectors) from the DB, then spawns `python -m simulate.experiments.pca_clusters` with cwd = project root, writes the JSON input to stdin, and parses stdout as JSON.
   - Use the Python interpreter from the same environment the other Python tooling uses (VERIFY FIRST G). If none is set, use `python`.
   - On non-zero exit, throw an Error with stderr.
4. Add a test `simulate/experiments/test_pca_clusters.py` with synthetic data: 3 blobs of 10 points each. Assert that the result has `k == 3` and that each blob maps to one cluster.

### Fallback if Python is not usable
If the server cannot run Python at all (VERIFY FIRST G/H), port `compute` to Node using `ml-hclust`-style Ward or a small hand-rolled Ward agglomeration, PCA via power iteration on the 2x2 covariance, and silhouette directly. Record this choice in the summary.

## Phase 6: Tests

- **Unit:** `server/test/stats-cache.test.js` (Phase 2), `server/test/stats-feeds.test.js` (the totals mapping from 4a using a fixture array of 3 rows: one OK, one blocked, one HTTP error), `simulate/experiments/test_pca_clusters.py` (Phase 5).
- **E2E:** add `tests/e2e/statistics.test.js`:
  1. Sidebar Statistics button navigates to `/statistics`.
  2. Four cards are present, each with a Generate button.
  3. Clicking Generate on `lr_metrics` (cheapest) shows a table or the "No model_eval rows" text, and the meta line shows a date.
  4. Reload the page: the card still shows the same meta line, and no new generation request is made (intercept the network and assert no POST).
- Run existing test suites to confirm nothing else broke. Look for the test command in `package.json` and `pyproject.toml`/`pytest.ini`.

## Phase 7: Cleanup and summary

- Confirm `experiments/feeds/audit_feeds.mjs` no longer exists (moved to `simulate/experiments/audit_feeds.mjs`).
- Grep the repo for `experiments/feeds` and fix any references (docs, scripts, AGENTS.md mentions). Do not edit AGENTS.md contract text except to update the path.
- Delete `docs/plans/statistics_page.notes.md` only after the summary is written.
- Final summary must list: files created, files changed, files deleted, which VERIFY FIRST answers you found, any deviations from this plan and why, and the test results.

## Acceptance criteria (all must hold)

1. Sidebar has a Statistics button that opens `/statistics`.
2. The page shows four cards with Generate buttons and the "Not generated yet" state on a fresh cache.
3. Each card's result survives a server restart (verify by stopping and starting the server).
4. Each card shows a generated date. The Outdated badge appears when the source changes.
5. Feed health table matches the output of `node simulate/experiments/audit_feeds.mjs`.
6. p/V card: one Plotly figure with two overlaid histograms, computed from the ranker, not read from the DB.
7. LR card: AUC and logLoss for prior / keyword / fitted, from `model_eval`.
8. PCA card: scatter coloured by cluster, one legend entry per cluster, centroids marked, groups distinguishable in hover text.
9. `simulate/experiments/audit_feeds.mjs` no longer exists; the script works from `simulate/experiments/`.
10. All new tests pass; no existing tests newly fail.
11. Every generate call goes to a path starting with `/api/restricted/`. No generate route exists under `/api/stats/`. Grep the server code for `/generate` and confirm each match uses `RESTRICTED_PREFIX`.
12. The E2E test in Phase 6 intercepts the generate request and asserts its URL starts with `/api/restricted/`.
