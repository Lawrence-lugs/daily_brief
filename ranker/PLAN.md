---
title: Daily Brief - logistic-regression update, implementation plan
date: 2026-10-29
---

# 0. What is already written (do not rewrite)

Drop `ranker/` into the project root (next to `server/`, `src/`). New code is JS (ESM, Node >= 22.13). The existing Python is only patched, not ported.

| file | what it is | tested |
|---|---|---|
| `ranker/agglo.js` | Ward clustering with the perfect-sample stopping rule; weighted medoid | yes, parity with sklearn Ward at fixed k (Rand index 1.0) |
| `ranker/interests.js` | build medoids from perfect samples + likes; top-3 distances; (de)serialise | yes |
| `ranker/features.js` | feature registry, author normalisation, `encode()` | yes |
| `ranker/model.js` | `SparseBayesLogReg` (replaceable), `auc`, `logLoss` | yes |
| `ranker/trainer.js` | cross-fitted training set (leak fix), chronological split | not unit-tested (needs vectors) |
| `ranker/sampler.js` | interest-level round robin + epsilon-greedy + freshness/dedupe | yes |
| `ranker/simulate.js` | ephemeral Monte-Carlo preview, `--set` overrides | smoke only |
| `ranker/vec.js`, `embedder.js` | vector helpers; bge-micro-v2 wrapper |  |
| `ranker/test/ranker.test.js` | 15 tests, `node --test ranker/test/ranker.test.js` | all pass |

**Still to be written by the local model (glue only):** `store.js`, `pipeline.js`, `cli.js`, Python patches, `perfect_samples.json`.

## Key algorithms in one place

Ward cut, spec reading: agglomerate by increasing height and **stop at the first merge that would put two perfect samples in one cluster**. That height is the largest cut that still separates every perfect sample.

Medoid. For a cluster $C$ with weights $\alpha_i$ ($\kappa=20$ for perfect samples, 1 otherwise):

$$p_{\text{mid}}=\arg\min_{p\in C}\sum_i \alpha_i\|p-x_i\|^2=\arg\min_{p\in C}\|p-c_\alpha\|^2,\qquad c_\alpha=\frac{\sum_i\alpha_i x_i}{\sum_i\alpha_i}$$

because $\sum_i\alpha_i\|p-x_i\|^2=W\|p-c_\alpha\|^2+\text{const}$. So the code picks the member nearest the weighted centroid.

Model. Independent Gaussian prior per feature, $w_j\sim\mathcal N(m_j,\lambda_j^{-1})$. MAP by cyclic coordinate Newton with a trust region (cost $O(\text{nnz})$ per sweep, so thousands of one-hot authors are fine). Diagonal Laplace posterior $\lambda_j+\sum_i s_i x_{ij}^2 p_i(1-p_i)$. Predictive (probit approximation):

$$p=\sigma\!\left(\frac{\mu}{\sqrt{1+\pi\sigma^2/8}}\right),\quad \mu=w^\top x,\quad \sigma^2=\sum_j x_j^2/\text{prec}_j$$

Unknown keys (unseen author, cold start) fall back to their prior. With zero data the model *is* its prior: bias mean $-2$ (base like rate), $d_1$ slope $-0.8$ (closer to a medoid, more likely liked). That is the cold-start behaviour.

Value used for sampling ($\lambda=\ln 2/t_{1/2}$, $L$ logistic in days since last shown, 1 if never shown):

$$V = S\cdot e^{-\lambda A}\cdot L(\text{days since shown};t_0,s)$$

# 1. Decisions I made that you should confirm

1. **Dedupe wording was contradictory** ("remove items already in stories" vs "penalise at a decreasing rate"). Implemented both: hard-remove if shown within `hardWindowDays` (default 2), logistic recovery after that (`t0=7`, `scale=2`). Change in `config.ranker.sampling.dedupe`.
2. **Training labels**: one row per *item* (first exposure date, label = ever liked or saved). The existing `training_examples` view is per (date, item), so an item liked on day 1 and re-shown on day 9 would give a false negative. SQL below.
3. **Cross-fitting** (`trainer.js`): liked items build the medoids, so their own $d_1\approx0$ leaks the label. Features of each example come from medoids built without that fold's liked items (K=5). Serving uses the full medoids.
4. **`stop` vs `constrained`**: spec = `stop`. Risk: two near-duplicate perfect samples stop the merge very early and leave dozens of singleton "interests". The refit log must print cluster count, `stopHeight` and a size histogram. If it looks shredded, set `interests.mode = "constrained"` (never merges two clusters that each hold a perfect sample, but keeps merging the rest).
5. **Desk mapping**: `primary` = core clusters (round robin), `science` = everything else. The desk titles still come from `sources.json`; you may want to retitle them.
6. **Keyword gate stays**: `classify()` still drops off-topic items before they enter the pool, so embeddings never see them. Only the *sorting/scoring/sampling* changes.
7. **Dropped**: `minimum_types` (newslike>=1, paperlike>=2). Type is now only a model feature. Add a quota back in `sampler.js` if the brief becomes all papers.
8. **LLM no longer samples**: for `engine=lr`, the editor sees only the picks (not the reserves). Reserves are only used by `apply_editor` to backfill rejections. Needs a prompt tweak (phase 6).
9. **A/B**: same-day regeneration supersedes the earlier brief (`counted=0`) and carries likes forward. So running keyword then lr on the same day is allowed, but counters/`training_examples` follow the last one. Fine for a temporary comparison.
10. Selection bias: only shown items have labels. The epsilon exploration is what keeps this from collapsing; no inverse-propensity weighting yet.

# 2. Patches to existing files

## 2.1 `schema.sql` (append before `PRAGMA user_version`, and change that pragma to `= 2`)

```sql
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
```

No `ALTER TABLE` needed (new tables only), so the "every statement is idempotent" property holds for both python and node.

## 2.2 Python: authors

`src/fetch/fetcher.py`

```python
def split_authors(text: str) -> list[str]:
    """arXiv dc:creator is ONE string 'Alice Smith, Bob Jones'. Split only when every piece has a space,
    so 'Smith, John' stays whole."""
    text = strip_html(text or "")
    parts = [p.strip() for p in re.split(r",|\band\b", text) if p.strip()]
    return parts if len(parts) > 1 and all(" " in p for p in parts) else ([text] if text else [])

# make_item(..., authors=None):  add param, and in the returned dict:   "authors": list(authors or []),

# parse_feed: before the loop over children:  authors = []
# inside `for ch in node:` add
#     elif t in ("creator", "author"):
#         nm = next((g.text for g in ch if local(g.tag) == "name"), None) or ch.text or ""
#         authors += split_authors(nm)
# and pass authors=authors to make_item(...)
```

`src/fetch/semanticscholar.py`: add `authors` to the `fields` string, and `authors=[a["name"] for a in item.get("authors") or [] if a.get("name")]` to `make_item(...)`.

`src/db.py` `upsert_pool`, inside the `for it in fresh:` loop after the pool INSERT:

```python
conn.execute(
    """INSERT INTO item_meta(item_id, authors) VALUES (?,?)
       ON CONFLICT(item_id) DO UPDATE SET authors=excluded.authors WHERE excluded.authors <> '[]'""",
    (it["id"], json.dumps(it.get("authors") or [], ensure_ascii=False)))
```

Also add a test in `src/test_db.py` that `item_meta` is written.

## 2.3 Python: engine switch in `src/brief.py`

```python
import os, subprocess
ap.add_argument("--engine", choices=["keyword", "lr"], help="override config.ranker.engine")
# after cfg is loaded:
engine = args.engine or cfg.get("ranker", {}).get("engine", "keyword")

def select_lr(pool, cfg, src, date_key, seed, scfg):
    """Returns {desk: [pool dicts with mode]} or None (caller falls back to the keyword path)."""
    cmd = [os.environ.get("BRIEF_NODE", "node"), str(PROJECT_ROOT / "ranker" / "cli.js"), "select", "--date", date_key]
    if seed is not None:
        cmd += ["--seed", str(seed)]
    try:
        r = subprocess.run(cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=900, check=True)
        out = json.loads(r.stdout)                      # stdout is JSON ONLY; node logs go to stderr
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as e:
        warn(f"lr engine failed ({type(e).__name__}: {e}); falling back to keyword selection")
        return None
    for line in r.stderr.splitlines():
        log(line)
    by_id = {p["id"]: p for p in pool}
    sel_out = {d: [dict(by_id[x["id"]], mode=x["mode"]) for x in out.get(d, []) if x["id"] in by_id]
               for d in src["desks"]}
    for d in sel_out.values():
        for c in d:
            c["kind"] = sel.kind_of(c, scfg)
    return sel_out
```

In `main()`: `selected = select_lr(...) if engine == "lr" else None`; if `selected is None`, run the existing step 2 unchanged. Then:
- in step 3, when `engine == "lr"` and the LLM ran, call `build_user_message(spec["title"], n, [c for c in selected[desk] if c["mode"] != "reserve"], today_s, keep_cap=None)` (picks only), but still pass the full `selected[desk]` to `apply_editor` so reserves can backfill rejections;
- add `"engine": engine` to `meta`.

`server/lib/render.js`: dropdown label `${b.date} ${t}`; append `meta.engine` (needs `listBriefs` to select `json_extract(meta,'$.engine')`). Optional, small.

## 2.4 `config.json` (new top-level key; `slots.primary/science/reserve` default to `stories_per_desk`/`reserve_per_desk`)

```json
"ranker": {
  "engine": "keyword",
  "perfect_samples_file": "perfect_samples.json",
  "label": "liked_or_saved",
  "features": ["bias", "type", "author", "medoid"],
  "authors": { "head": 3, "tail": 2, "threshold": 5 },
  "interests": { "kappa": 20, "maxLikedDays": 100, "mode": "stop", "minClusters": 1 },
  "crossFit": { "folds": 5 },
  "model": {
    "name": "bayes_lr", "maxSweeps": 60, "tol": 0.0001,
    "numDefault": { "mean": 0.45, "std": 0.15 },
    "prior": {
      "default": { "prec": 1, "mean": 0 },
      "rules": [
        { "match": "b",    "prec": 0.5, "mean": -2 },
        { "match": "t:",   "prec": 2 },
        { "match": "a:",   "prec": 3 },
        { "match": "n:d1", "prec": 1, "mean": -0.8 },
        { "match": "n:d2", "prec": 2, "mean": -0.2 },
        { "match": "n:d3", "prec": 2 }
      ]
    }
  },
  "sampling": {
    "epsilon": 0.25, "halfLifeDays": 7,
    "desks": { "core": "primary", "side": "science" },
    "explore": { "gamma": 0.5, "floor": 0.01 },
    "dedupe": { "hardWindowDays": 2, "t0": 7, "scale": 2 }
  }
}
```

`numDefault` should be replaced by real stats at the first fit (the model computes them from the candidate pool); it only matters before that.

## 2.5 `perfect_samples.json` (human task, see phase 3)

```json
[ { "id": "cim-1", "title": "...", "snippet": "...", "type": "paperlike", "core": true } ]
```

# 3. Contracts for the glue modules (verified SQL)

All SQL below was run against a mock of the real schema with `node:sqlite`.

## 3.1 `ranker/store.js` (thin wrapper, `DatabaseSync` handle in, plain objects out)

```js
// open with the same pragmas as server/lib/queries.js openDb (reuse it: import { openDb } from '../server/lib/queries.js')
export const SQL = {
  missingEmbeddings: `
    SELECT p.item_id AS id, p.title AS title, p.snippet AS body
      FROM candidate_pool p LEFT JOIN embeddings e ON e.item_id=p.item_id WHERE e.item_id IS NULL
    UNION
    SELECT s.item_id, s.headline, s.blurb
      FROM stories s LEFT JOIN embeddings e ON e.item_id=s.item_id
     WHERE e.item_id IS NULL AND NOT EXISTS (SELECT 1 FROM candidate_pool p WHERE p.item_id=s.item_id)
     GROUP BY s.item_id`,                       // pool text first; story headline+blurb only as a fallback
  likedIds: `SELECT DISTINCT s.item_id FROM stories s JOIN briefs b ON b.brief_id=s.brief_id
              WHERE (s.liked=1 OR s.saved=1) AND b.date >= ?`,               // ? = today - maxLikedDays (local YYYY-MM-DD)
  lastShown: `SELECT s.item_id, MAX(b.generated_at) AS last FROM stories s JOIN briefs b ON b.brief_id=s.brief_id
               WHERE b.date < ? GROUP BY s.item_id`,                          // ? = today; ignores today's superseded editions
  trainingRows: `
    SELECT t.item_id, MAX(t.source_type) AS source_type, MIN(t.date) AS date,
           MAX(CASE WHEN t.liked=1 OR t.saved=1 THEN 1 ELSE 0 END) AS y, m.authors
      FROM training_examples t LEFT JOIN item_meta m ON m.item_id=t.item_id
     GROUP BY t.item_id ORDER BY date, t.item_id`,
  pool: `SELECT p.*, m.authors FROM candidate_pool p LEFT JOIN item_meta m ON m.item_id=p.item_id`,
  prune: `DELETE FROM embeddings WHERE item_id NOT LIKE 'ps:%' AND item_id NOT IN
            (SELECT item_id FROM candidate_pool UNION SELECT item_id FROM stories)`,
};
// authors column is a JSON string or NULL -> JSON.parse(x ?? '[]') before use
// vectors: store with toBlob(f32), read with fromBlob(u8)  (vec.js)
// state: getState(key) / setState(key, jsonString) on ranker_state
```

## 3.2 `ranker/pipeline.js`

```js
export async function ensureEmbeddings(db, cfg, {persist = true})   // missingEmbeddings -> embedTexts(textOf(title, body)) -> INSERT; perfect samples as 'ps:<id>' (re-embed on text_hash change); then SQL.prune
export async function ensureFitted(db, cfg, {persist = true, force = false})
//   fitKey = sha1(JSON.stringify([perfect (id,text_hash,core), sorted likedIds, trainingRows (item_id,y),
//                                 cfg.interests, cfg.features, cfg.authors, cfg.crossFit, cfg.model, ENCODING_VERSION]))
//   if getState('fit_key') === fitKey && !force -> hydrate {interests, model} from ranker_state and return
//   else: build via trainer.buildTrainingSet; model = new MODELS[cfg.model.name](cfg.model);
//         model.fit(examples, { scaleSample: encoded pool candidates under `full` interests });
//         persist -> setState('interests', serializeInterests(full)), setState('model', JSON.stringify(model)), setState('fit_key', key)
//   ALWAYS log to stderr: #perfect, #liked, #clusters (core/side), stopHeight, cluster size histogram, #examples, #positives
export function prepareCandidates(db, cfg, {interests, model}, dateKey, now)
//   for each pool row WITH an embedding (warn on count without): item = {...row, vec, authors:JSON.parse(row.authors ?? '[]')}
//   {keys, vals} = encode(item, {interests, authorCfg: cfg.authors}, cfg.features)
//   p = model.predict(keys, vals).p;  {cid} = nearest(interests, vec);  core = interests.clusters[cid].core
//   age_days = max(0, (now - Date.parse(published ?? first_seen))/86400000)
//   days_since_shown = (dateKey - lastShown(item)) in days, null if never shown
//   -> {id: item_id, title, source_type, p, age_days, days_since_shown, cluster: cid, core}
```

## 3.3 `ranker/cli.js` (node:util `parseArgs`; **stdout is reserved for the JSON of `select`; everything else goes to stderr**)

| command | behaviour |
|---|---|
| `embed` | `ensureEmbeddings` |
| `refit [--force]` | `ensureEmbeddings` + `ensureFitted`, prints the diagnostics |
| `select --date D [--seed N]` | embed, fit if stale, prepareCandidates, `selectBrief(..., mulberry32(seed ?? Date.now()))`; prints `{desk:[{id,mode,p,V,cluster,core}]}`. Exit 3 if interests cannot be built (brief.py then falls back to keywords) |
| `simulate [--runs 200] [--seed 1] [--set a.b=v ...]` | `applyOverrides`, `ensureFitted({persist:false})`, `prepareCandidates`, `simulate(...)`; **no writes at all**; prints JSON summary |
| `eval` | `chronoSplit(examples)`, fit on train, report `auc` and `logLoss` on test, also for the baselines "prior only" and "keyword rel" |
| `inspect` | top 20 positive/negative weights (`model.weights()`), cluster list with medoid titles |

In `simulate`, items without a stored embedding are skipped and counted (no model download in a preview).

# 4. Phases (each is one subagent session, < 100K tokens)

General rules for every subagent: **do not open `node_modules/`, `logs/agent_responses.jsonl`, `*.db*`, `outputs/` or `.agents/old_do_not_read/`.** Commit before and after each phase. Do not edit files already in `ranker/` except for bug fixes with a failing test first.

## Phase 0 - preflight (5 min, by hand)
- `node -v` >= 22.13; `npm i @xenova/transformers` in the project root; copy `ranker/` and `PLAN.md` in.
- `node --test ranker/test/ranker.test.js` must be green. `python -m pytest src/test_db.py tests` must be green (baseline).
- Back up `daily_brief.db`.

## Phase 1 - schema and authors (Python + SQL only)
- Read: `schema.sql`, `src/db.py`, `src/fetch/fetcher.py` (functions `make_item`, `parse_feed` only), `src/fetch/semanticscholar.py`, `src/test_db.py`.
- Do: sections 2.1, 2.2. Add `split_authors` tests (`'Alice Smith, Bob Jones'` -> 2, `'Smith, John'` -> 1) and an `item_meta` upsert test.
- Done when: `python -m pytest src/test_db.py tests` green; `python src/brief.py --no-llm --dry-run` runs; `sqlite3 daily_brief.db "select count(*) from item_meta where authors<>'[]'"` > 0 after a fetch; `node server/test/server.test.js` still green (it executes the same schema).

## Phase 2 - store, embedder, `embed` command
- Read: `ranker/vec.js`, `ranker/embedder.js`, `server/lib/queries.js` (openDb only), `bge-embedding/embed.js` (reference), section 3.1.
- Write: `ranker/store.js`, `ranker/cli.js` (only `embed`), `ranker/pipeline.js` (`ensureEmbeddings` only).
- Done when: `node ranker/cli.js embed` fills `embeddings` for every pool row and is a no-op on the second run. **Parity test**: for 5 items present in both `reference/state.json` + `bge-embedding/embeddings.json` and the new embedder, cosine similarity > 0.999 (same quantised ONNX model, so this validates the wrapper). Add `ranker/test/store.test.js` using an in-memory DB and the schema file.

## Phase 3 - interests (human step, then code)
- **Human first**: write `perfect_samples.json` (title, snippet, type, core). A few per core research interest, plus a handful of non-core ones. A subagent may *suggest* candidates (`SELECT headline, blurb FROM stories WHERE liked=1`), but you decide the labels and `core`.
- Read: `ranker/agglo.js`, `ranker/interests.js`, section 3.2.
- Write: `ensureFitted` **interests part only** (build + persist + log diagnostics), `refit` command, `inspect` (clusters only).
- Done when: `node ranker/cli.js refit` prints sensible cluster count, `stopHeight`, sizes; each core sample sits in its own cluster; medoid titles look like the interest they represent. If clusters are shredded, try `interests.mode="constrained"` before touching code.
- Optional validation with the old Python tool: run `python -m clustering state` on the same embeddings and eyeball that the groupings agree.

## Phase 4 - features, model, training, eval
- Read: `ranker/features.js`, `ranker/model.js`, `ranker/trainer.js`, section 3.1 `trainingRows`.
- Write: the model half of `ensureFitted` (`fit_key`, cross-fit, persist), `eval`, `inspect` (weights).
- Done when: `refit` twice -> second is a cache hit; `eval` prints AUC/logLoss for {prior-only, keyword `rel`, fitted}; fitted >= prior-only on the chronological holdout once you have >= ~30 positives (before that, only check it does not crash and that it equals the prior with zero examples).
- Known limit: the diagonal posterior ignores correlation between $d_1,d_2,d_3$. Do not "fix" it with a dense Hessian.

## Phase 5 - `prepareCandidates`, `select`, `simulate`
- Read: `ranker/sampler.js`, `ranker/simulate.js`, section 3.2 `prepareCandidates`, 3.3.
- Write: `prepareCandidates`, `select`, `simulate` commands.
- Done when: `node ranker/cli.js select --date 2026-10-29 --seed 1` prints valid JSON on stdout only (pipe it to `jq .` and check stderr is separate); two runs with the same seed are identical; `simulate --runs 200` gives `consecutiveJaccard` well below 1 and `distinctClusters` for the primary desk > 1; **simulation leaves `daily_brief.db` byte-identical** (compare sha256 before/after, WAL checkpointed).

## Phase 6 - integrate into `brief.py`, A/B, prompt
- Read: `src/brief.py`, `src/agent.py` (`build_user_message`, `apply_editor` only), `prompt_system.md`, `server/lib/queries.js` (`listBriefs`), `server/lib/render.js` (options block).
- Do: section 2.3 and the dropdown label. Edit `prompt_system.md`: for picks-only runs the editor should keep every candidate unless unusable (read the file first, change the minimum). Run both engines on the same day.
- Done when: `python src/brief.py --engine lr --no-llm` and `--engine keyword --no-llm` both write a brief; killing `node` (set `BRIEF_NODE=nonexistent`) makes the lr run fall back with a warning; `meta.engine` is stored; the server dropdown shows the engine; all python and node tests green.

## Phase 7 - tuning loop (you + a model, repeatable)
- Use `simulate --set ...` to tune `epsilon`, `halfLifeDays`, `dedupe.*`, `explore.gamma`; use `eval` to tune the priors. Targets: lr brief at least as liked as the keyword brief over ~2 weeks of A/B.
- Then decide: drop the keyword engine, retitle desks, re-add type quotas.

# 5. Risks to keep in mind

- `stop` mode shredding (decision 4). Likes arrive slowly, so for the first weeks the clusters are basically the perfect samples; that is intended.
- Few positives: expect AUC to be noisy for a while. The prior keeps scores sane, but do not over-read `eval` early.
- `select` loads the ONNX model each run (a few seconds). Acceptable once a day; if not, keep embeddings fresh in the server process instead.
- Author keys `surname|initial` merge different people (A. Smith); accepted, per your "take the risk". The prior precision (`a:` = 3) limits the damage of any single collision.
- The old python `selection.py` is untouched and remains the fallback.
