# Ranker — Bayesian LR + Ward Clustering

The `ranker/` module replaces the legacy keyword-based selection (`src/selection.py`) with a learned
ranking model built on **embeddings + author + interest-distance features**, trained by **Bayesian
logistic regression** with a diagonal Laplace posterior, and organised into **interest clusters via
Ward agglomerative clustering with a perfect-sample stopping rule**.

This is a self-contained Node ESM module (Node ≥ 22.13, no bundler). It reads/writes the same
SQLite database (`daily_brief.db`) as the Python code and the Node server.

---

## Quick Start

```bash
# 1. Install the embedding model (one-time, ~50 MB)
npm i @xenova/transformers

# 2. Write perfect_samples.json (see below)

# 3. Embed all pool/story items + perfect samples
node ranker/cli.js embed

# 4. Build interests + fit model (or load from cache)
node ranker/cli.js refit

# 5. Select a brief for today (JSON to stdout; logs to stderr)
node ranker/cli.js select --date 2026-10-29 --seed 42

# 6. Or run a Monte-Carlo simulation (no DB writes)
node ranker/cli.js simulate --date 2026-10-29 --runs 200 --set sampling.epsilon=0.2

# 7. Evaluate on chronological holdout
node ranker/cli.js eval --testFrac 0.2

# 8. Inspect weights and clusters
node ranker/cli.js inspect
```

---

## CLI Reference

| Command | Purpose | Key Options |
|---|---|---|
| `embed` | Compute & store embeddings for all pool/story items + perfect samples | — |
| `refit [--force]` | Build interests, cross-fit training set, fit model; persist to `ranker_state` | `--force` = ignore cache |
| `select --date D [--seed N]` | Full pipeline → brief selection; prints JSON `{desk:[{id,mode,p,V,cluster,core}]}` | `--seed` for reproducibility; exits 3 if no interests |
| `simulate [--runs N] [--seed N] [--set a.b=v...]` | Ephemeral Monte-Carlo; **no DB writes**; prints summary JSON | `--set` for config overrides (e.g. `--set sampling.epsilon=0.1`) |
| `eval [--testFrac F]` | Chronological holdout: AUC & logLoss for prior / keyword-rel / fitted | `--testFrac` default 0.2 |
| `inspect` | Top 20 ± model weights + cluster list with medoid titles | — |

**Important:** `stdout` is reserved for the JSON output of `select` and `simulate` (and `eval`/`inspect`).
All logs, warnings, diagnostics go to `stderr`. This allows piping `select` output directly to
`jq` or `python -c "import sys,json; print(json.load(sys.stdin))"`.

---

## Perfect Samples (`perfect_samples.json`)

Human-curated anchor items that define the "core" research interests. Each entry:

```json
{
  "id": "cim-1",
  "title": "Attention Is All You Need",
  "snippet": "The Transformer architecture for sequence transduction.",
  "type": "paperlike",
  "core": true
}
```

- `core: true` → defines a **core cluster** (round-robin on the primary desk).
- `core: false` → side interest (goes to the science desk).
- The `id` is arbitrary; the ranker prefixes it with `ps:` internally.
- A few per core interest, plus a handful of non-core ones. **You decide the labels.**

---

## Configuration (`config.json` → `ranker` key)

```jsonc
"ranker": {
  "engine": "lr",                          // "keyword" | "lr"
  "perfect_samples_file": "perfect_samples.json",
  "label": "liked_or_saved",               // training label
  "features": ["bias", "type", "author", "medoid"],
  "authors": { "head": 3, "tail": 2, "threshold": 5 },
  "interests": {
    "kappa": 20,                           // weight of perfect samples in medoid
    "maxLikedDays": 100,                   // lookback for liked items
    "mode": "constrained",                 // "stop" (spec) | "constrained" (never merge two perf clusters)
    "minClusters": 1
  },
  "crossFit": { "folds": 5 },              // K-fold cross-fitting for leak-free features
  "model": {
    "name": "bayes_lr",
    "maxSweeps": 60, "tol": 1e-4,
    "numDefault": { "mean": 0.45, "std": 0.15 }, // z-score stats for numeric features (fallback)
    "prior": {
      "default": { "prec": 1, "mean": 0 },
      "rules": [
        { "match": "b",    "prec": 0.5, "mean": -2 },   // bias → base like rate ~12%
        { "match": "t:",   "prec": 2 },                 // type features
        { "match": "a:",   "prec": 3 },                 // author features (many, so strong shrinkage)
        { "match": "n:d1", "prec": 1, "mean": -0.8 },   // closest medoid distance (negative → closer = more likely)
        { "match": "n:d2", "prec": 2, "mean": -0.2 },
        { "match": "n:d3", "prec": 2 }
      ]
    }
  },
  "sampling": {
    "epsilon": 0.25, "halfLifeDays": 7,
    "desks": { "core": "primary", "side": "science" },
    "explore": { "gamma": 0.5, "floor": 0.01 },
    "dedupe": { "hardWindowDays": 2, "t0": 7, "scale": 2 },
    "slots": { "primary": 5, "science": 5, "reserve": 25 }
  }
}
```

### Key Config Knobs

| Knob | Effect | Typical Range |
|---|---|---|
| `sampling.epsilon` | Exploration probability per draw | 0.15–0.35 |
| `sampling.halfLifeDays` | Freshness decay (exp) | 5–14 |
| `sampling.dedupe.hardWindowDays` | Hard-remove if shown within this many days | 1–3 |
| `sampling.dedupe.t0` / `scale` | Logistic recovery after hard window | t0=5–10, scale=1–3 |
| `sampling.explore.gamma` | Flattening of explore weights (V^γ) | 0.3–0.7 |
| `interests.mode` | `"stop"` = spec (stop at first perf-perf merge); `"constrained"` = never merge two perf clusters | `"constrained"` if shredded |
| `interests.kappa` | Weight of perfect samples in medoid calculation | 10–50 |
| `model.prior.rules` | Per-feature Gaussian prior (prec=1/variance) | tune via `eval` |

---

## How It Works (90-second version)

### 1. Embeddings
- **Model:** `TaylorAI/bge-micro-v2` (384-d, L2-normalised) via `@xenova/transformers`.
- **Text:** `title + " " + snippet` (pool) or `headline + " " + blurb` (stories fallback).
- **Caching:** Stored in `embeddings` table with `text_hash` (sha1[:12]); re-embedded on text change.
- **Perfect samples:** Embedded as `ps:<id>`, never pruned.

### 2. Interests (Ward + Perfect-Sample Stop)
- **Input:** Perfect samples (weight `κ=20`) + liked items from last `maxLikedDays` (weight 1).
- **Algorithm:** Agglomerative Ward (squared Euclidean on unit sphere ≈ cosine).
- **Stop rule (`mode="stop"`):** Stop at the **first merge that would put two perfect samples in the same cluster**. That height is the largest cut separating all perfect samples.
- **Alternative (`mode="constrained"`):** Never merge two clusters that each contain a perfect sample, but keep merging the rest. Use this if `stop` yields dozens of singletons.
- **Medoid:** Weighted centroid `c_α = Σ α_i x_i / Σ α_i`; pick the member nearest to it.
- **Core flag:** A cluster is `core` if it contains ≥1 `core:true` perfect sample.

### 3. Features (per item)
| Feature | Key prefix | Type | Description |
|---|---|---|---|
| bias | `b` | const 1 | Base log-odds |
| source_type | `t:<type>` | one-hot | `newslike`, `paperlike`, `researchlike`, `commentary` |
| author | `a:<surname\|initial>` | one-hot (scaled 1/√n) | Top `head` + bottom `tail` authors if > `threshold` |
| medoid distance | `n:d1` `n:d2` `n:d3` | numeric | Cosine distance to 3 nearest medoids (z-scored at fit time) |

**Cold start:** Unknown keys (unseen author, new medoid) fall back to their prior. With zero training data the model **is its prior** (bias mean −2 → ~12% base like rate; `d1` mean −0.8 → closer to a medoid → more likely liked).

### 4. Model: SparseBayesLogReg
- **Prior:** Independent Gaussian per feature `w_j ~ N(m_j, 1/λ_j)`.
- **MAP:** Cyclic coordinate Newton with per-coordinate trust region (Genkin/Lewis/Madigan BBR). Cost `O(nnz)` per sweep → thousands of one-hot authors are fine.
- **Posterior:** Diagonal Laplace `λ_j + Σ_i s_i x_ij² p_i(1-p_i)`.
- **Predictive (probit approximation):**
  ```
  p = σ( μ / √(1 + πσ²/8) )
  μ = wᵀx
  σ² = Σ x_j² / prec_j
  ```

### 5. Cross-Fitting (Leak Fix)
Liked items **build the medoids**, so their own `d1 ≈ 0` leaks the label.
- Split liked items into `K=5` folds by hash(item_id).
- For examples in fold `f`, build interests from perfect + liked \ fold `f`.
- Serving uses **full** interests (all liked items).
- `fitKey` = SHA1 of `[perfect, liked, trainingRows, config, ENCODING_VERSION]` → cache in `ranker_state`.

### 6. Selection (Sampler)
1. **Score:** `S = model.p` (like probability).
2. **Value:** `V = S · exp(-λ·age) · dedupe(days_since_shown)`
   - `λ = ln 2 / halfLifeDays`
   - `dedupe = 1` if never shown; `0` if `days_since_shown < hardWindowDays`; logistic recovery after.
3. **Primary desk:** Round-robin over **core clusters** (random cluster order per day). Each draw: epsilon-greedy on `V` within that cluster's pool.
4. **Science desk:** All non-core items as one pool; epsilon-greedy on `V`.
5. **Backfill:** If a desk is short, pull from leftovers (any cluster).
6. **Reserves:** Best leftovers by `V` per desk (editor backfill on rejection).

---

## Cache Invalidation (`fitKey`)

The `fitKey` is a SHA1 hash of:
1. Perfect samples: `[(id, text_hash, core)]` sorted
2. Liked item IDs (sorted)
3. Training rows: `[(item_id, y, source_type, authors)]` sorted
4. Config sections: `interests`, `features`, `authors`, `crossFit`, `model`
5. `ENCODING_VERSION` (bump when `encode()` behaviour changes)

If `fitKey` matches the cached value in `ranker_state`, `refit` loads interests + model from DB and
skips recomputation. Use `--force` to ignore the cache.

---

## Testing

```bash
# Unit tests (pure functions: agglo, interests, features, model, sampler, simulate)
node --test ranker/test/ranker.test.js

# Integration: embed → refit → select (requires DB with data)
node ranker/cli.js embed
node ranker/cli.js refit
node ranker/cli.js select --date 2026-10-29 --seed 1 | jq .
```

---

## Files Overview

| File | Role |
|---|---|
| `cli.js` | CLI entry point (parseArgs); stdout=JSON, stderr=logs |
| `store.js` | Thin `node:sqlite` wrapper; prepared statements for all ranker SQL |
| `pipeline.js` | `ensureEmbeddings`, `ensureFitted`, `prepareCandidates`, `evalModel` |
| `embedder.js` | `@xenova/transformers` wrapper for bge-micro-v2 |
| `vec.js` | dot, normalize, Float32Array ↔ Uint8Array (SQLite BLOB) |
| `agglo.js` | Ward clustering + perfect-sample stop + weighted medoid |
| `interests.js` | Build interests from perfect + liked; serialize/hydrate (vectors live in embeddings table) |
| `features.js` | Feature registry + `encode(item, ctx, enabled)` |
| `model.js` | `SparseBayesLogReg` + `auc` / `logLoss` |
| `trainer.js` | Cross-fitted training set (`buildTrainingSet`), `chronoSplit` |
| `sampler.js` | `selectBrief`, `value`, `draw`, `mulberry32` RNG |
| `simulate.js` | Monte-Carlo preview (`consecutiveJaccard`, `distinctClusters`, `topIncluded`) |
| `test/ranker.test.js` | 15 unit tests (all pass) |

---

## Integration with Python (`src/brief.py`)

```python
# In brief.py main():
engine = args.engine or cfg.get("ranker", {}).get("engine", "keyword")

if engine == "lr":
    selected = select_lr(date_key, args.seed, cfg, src, pool, now)
    # select_lr calls: node ranker/cli.js select --date D [--seed N] [--set ...]
    # Falls back to keyword on any error (non-zero exit, invalid JSON, etc.)
```

- LR engine: editor sees **picks only** (no reserves). Reserves are passed to `apply_editor` for backfill.
- Keyword engine: editor sees picks + reserves (legacy behaviour).
- `meta.engine` is stored in `briefs.meta` → shown in server dropdown.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `refit` prints `clusters=0` or many singletons | `stop` mode + near-duplicate perfect samples | Set `interests.mode = "constrained"` |
| `select` exits 3 | No perfect samples AND no liked items (cold start) | Add `perfect_samples.json` or wait for likes |
| `embed` downloads model every run | `@xenova/transformers` caches in `~/.cache/huggingface` | First run is slow; subsequent are fast |
| `simulate` shows `consecutiveJaccard ≈ 1` | `epsilon` too low or pool too small | Increase `epsilon`, check `cfg.slots` |
| AUC NaN in `eval` | No positive/negative examples in test split | Need more labeled data; prior-only is the fallback |

---

## Extending

- **New feature:** Add extractor to `EXTRACTORS` in `features.js`, add name to `config.ranker.features`, bump `ENCODING_VERSION`.
- **New model:** Implement `fit`/`predict`/`toJSON`/`fromJSON` contract (see `model.js`), register in `MODELS`, set `config.ranker.model.name`.
- **Different embedding model:** Change `MODEL` and `DIM` in `embedder.js`; re-embed everything (`text_hash` changes).