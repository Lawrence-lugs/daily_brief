# Model: Bayesian Logistic Regression + Ward Clustering

This document describes the new ranking model in `ranker/`: a **Bayesian logistic regression** over
embedding/author/medoid features, trained with a diagonal Laplace posterior, organized into **interest clusters via
Ward agglomerative clustering with a perfect-sample stopping rule**. It replaces the legacy keyword-based selection
(`src/selection.py`).

Read alongside: `ranker/README.md` (CLI + config reference) and `docs/architecture.md` (call paths).

---

## 1. High-Level Pipeline

```
perfect_samples.json + liked items (DB)
        │
        ▼
Ward agglomerative clustering (perfect-sample stop rule)
        │
        ▼
interests = {clusters, medoids, core flags}
        │
        ▼
cross-fitted training set (K=5, leak fix) ← labels from liked/saved
        │
        ▼
SparseBayesLogReg fit (cyclic coordinate Newton, diagonal Laplace)
        │
        ▼
persisted to ranker_state (fitKey cache)
        │
        ▼
prepareCandidates: encode features → model.p (like probability)
        │
        ▼
sampler: value = p · freshness · dedupe → epsilon-greedy round-robin
        │
        ▼
brief per desk (picks + reserves)
```

---

## 2. Embeddings

- **Model:** `TaylorAI/bge-micro-v2` (384-dimensional, L2-normalised) via `@xenova/transformers`.
- **Text embedded:** `title + " " + snippet` for pool items; `headline + " " + blurb` for stories (fallback).
- **Storage:** `embeddings(item_id, model, text_hash, dim, vec BLOB)`. `vec` is a Float32Array(384), L2-normalised,
  stored as a SQLite BLOB (`vec.js`: `toBlob`/`fromBlob`).
- **Cache invalidation:** `text_hash = sha1(text)[:12]`; re-embed when it changes. Perfect samples are embedded as
  `ps:<id>` and never pruned (see `store.prune`).
- **Cold start:** Items without an embedding are skipped during selection with a stderr warning.

---

## 3. Interests: Ward Clustering + Perfect-Sample Stop

### 3.1 Inputs

- **Perfect samples** (`perfect_samples.json`): human-curated anchor items. Each has `id`, `title`, `snippet`,
  `type`, and `core` (boolean). Weight `κ` (default 20) in the medoid.
- **Liked items:** stories with `liked=1 OR saved=1` from the last `maxLikedDays` (default 100). Weight 1.

### 3.2 Algorithm (`ranker/agglo.js`)

1. Start with every item as its own cluster.
2. Repeatedly merge the pair of clusters that minimises the **Ward linkage** increase in within-cluster
   sum-of-squares (on the unit sphere, squared Euclidean ≈ cosine distance).
3. **Stop rule (`interests.mode = "stop"`):** Stop at the **first merge that would put two perfect samples in the
   same cluster**. That height is the largest cut still separating every perfect sample. This is the spec behavior.
4. **Alternative (`interests.mode = "constrained"`):** Never merge two clusters that each already contain a perfect
   sample, but keep merging everything else. Use this if `stop` yields dozens of shredded singletons (the current
   default in `config.json`).

### 3.3 Medoid

For cluster $C$ with weights $\alpha_i$ ($\kappa=20$ for perfect samples, 1 otherwise):

$$c_\alpha = \frac{\sum_i \alpha_i x_i}{\sum_i \alpha_i}, \qquad
p_{\text{mid}} = \arg\min_{p \in C} \|p - c_\alpha\|^2$$

Because $\sum_i \alpha_i \|p - x_i\|^2 = W\|p - c_\alpha\|^2 + \text{const}$, the code picks the member nearest the
weighted centroid.

### 3.4 Core flag

A cluster is `core` if it contains ≥1 `core:true` perfect sample. Core clusters drive the primary desk (round-robin);
non-core items go to the science desk.

---

## 4. Features (`ranker/features.js`)

| Feature | Key prefix | Type | Description |
|---------|------------|------|-------------|
| bias | `b` | const 1 | Base log-odds intercept |
| source_type | `t:<type>` | one-hot | `newslike`, `paperlike`, `researchlike`, `commentary` |
| author | `a:<surname\|initial>` | one-hot (scaled $1/\sqrt n$) | Top `head` + bottom `tail` authors if item has > `threshold` authors |
| medoid distance | `n:d1`, `n:d2`, `n:d3` | numeric | Cosine distance to the 3 nearest medoids (z-scored at fit time) |

**Author normalisation:** one-hot author keys are scaled by $1/\sqrt n$ where $n$ is the number of authors on the
item, so an item with many authors doesn't dominate any single author feature.

**Cold start / unknown keys:** Unseen authors or new medoids fall back to their prior (mean weight, prior variance).
With zero training data, the model *is* its prior: bias mean −2 (base like rate ≈ 12%), $d_1$ mean −0.8 (closer to a
medoid → more likely liked).

**`encode(item, ctx, enabled)`** returns `(keys, vals)`; numeric features are z-scored using stats computed from the
scale sample (candidate pool at fit time, falling back to `config.ranker.model.numDefault`).

---

## 5. Model: SparseBayesLogReg (`ranker/model.js`)

### 5.1 Prior

Independent Gaussian per feature:

$$w_j \sim \mathcal{N}(m_j, \lambda_j^{-1})$$

Per-feature prior from `config.ranker.model.prior`:

| match | prec | mean | Intent |
|-------|------|------|--------|
| `b` (bias) | 0.5 | −2 | Base like rate ~12% |
| `t:` (type) | 2 | 0 | Type features, mild shrinkage |
| `a:` (author) | 3 | 0 | Many authors → strong shrinkage |
| `n:d1` | 1 | −0.8 | Closest medoid: closer → more liked |
| `n:d2` | 2 | −0.2 | 2nd nearest |
| `n:d3` | 2 | 0 | 3rd nearest |
| default | 1 | 0 | Everything else |

Later rules override earlier; `match` ending with `:` is a prefix match.

### 5.2 MAP Estimation

Cyclic **coordinate Newton with a per-coordinate trust region** (Genkin/Lewis/Madigan "BBR"):

- Cost per sweep is $O(\text{nnz})$, so thousands of one-hot author features are fine (a dense Hessian would not be).
- Per coordinate $j$:
  $$g = \lambda_j (w_j - m_j) + \sum_i w_i x_{ij} (p_i - y_i), \quad
    h = \lambda_j + \sum_i w_i x_{ij}^2 p_i(1-p_i)$$
  $$step = \text{clip}(-g/h, [-\text{trust}_j, \text{trust}_j])$$
- Stops when `maxStep < tol` (default `1e-4`) or `maxSweeps` (default 60) is reached.

### 5.3 Posterior (Diagonal Laplace)

At the MAP, the diagonal Laplace posterior precision is:

$$\text{prec}_j = \lambda_j + \sum_i x_{ij}^2 p_i(1-p_i)$$

### 5.4 Predictive (Probit Approximation)

$$\mu = w^\top x, \qquad \sigma^2 = \sum_j \frac{x_j^2}{\text{prec}_j}$$

$$p = \sigma\!\left(\frac{\mu}{\sqrt{1 + \pi\sigma^2/8}}\right)$$

Unknown keys fall back to their prior mean/variance.

### 5.5 Evaluation Metrics

- `auc(scores, labels)` — Mann-Whitney AUC with tie handling.
- `logLoss(ps, ys)` — mean binary cross-entropy (clipped to $[10^{-9}, 1-10^{-9}]$).

---

## 6. Cross-Fitting (Leak Fix) (`ranker/trainer.js`)

**Problem:** Liked items build the medoids, so a liked item's own distance to its medoid is $d_1 \approx 0$, leaking
the label into the features.

**Fix:** K-fold cross-fitting (K=5):

1. Split liked items into 5 folds by `sha1(item_id)`.
2. For examples in fold $f$, build interests (medoids) from perfect samples + liked items **excluding** fold $f$.
3. Encode features using those fold-specific medoids.
4. Fit the model on the cross-fitted examples.
5. **Serving uses full interests** (all liked items) — no leakage at serve time because we only score, never re-fit.

`fitKey = SHA1([perfect (id, text_hash, core), sorted likedIds, trainingRows (item_id, y), config sections
(interests, features, authors, crossFit, model), ENCODING_VERSION])`. If `fitKey` matches the cached value in
`ranker_state`, `refit` hydrates interests + model from DB and skips recomputation. Use `--force` to ignore the cache.

`trainer.chronoSplit(examples)` performs a chronological split by `date` for `eval` (train on older, test on newer).

---

## 7. Selection / Sampling (`ranker/sampler.js`)

For each candidate item:

1. **Score:** $S = \text{model.p}$ (like probability from the probit-approximated predictive).
2. **Value:**
   $$V = S \cdot e^{-\lambda A} \cdot L(\text{days since shown})$$
   where $\lambda = \ln 2 / \text{halfLifeDays}$ (default 7), and
   $$L = \text{dedupe(days since shown)} = \frac{1}{1 + e^{-(d - t_0)/\text{scale}}}$$
   with $t_0=7$, $\text{scale}=2$. The hard window (`hardWindowDays`, default 2) is applied separately:
   items shown within `hardWindowDays` are **filtered out before scoring** in `selectBrief`, not zeroed by the dedupe function.
3. **Primary desk:** Round-robin over **core clusters** (random cluster order per day). Each draw: epsilon-greedy on
   $V$ within that cluster's pool.
4. **Science desk:** All non-core items as one pool; epsilon-greedy on $V$.
5. **Backfill:** If a desk is short, pull from leftovers (any cluster).
6. **Reserves:** Best leftovers by $V$ per desk (editor backfill on rejection; LR engine hides reserves from the LLM).

`mulberry32` RNG with `--seed` for reproducibility; two runs with the same seed are identical.

---

## 8. Files Reference

| File | Role |
|------|------|
| `ranker/model.js` | `SparseBayesLogReg` + `auc` / `logLoss` |
| `ranker/agglo.js` | Ward clustering + perfect-sample stop + weighted medoid |
| `ranker/interests.js` | Build interests from perfect + liked; serialize/hydrate |
| `ranker/features.js` | Feature registry + `encode()` |
| `ranker/trainer.js` | Cross-fitted training set + chronological split |
| `ranker/sampler.js` | `selectBrief`, `value`, `draw`, `mulberry32` |
| `ranker/store.js` | SQLite wrapper for embeddings/training rows/ranker_state |
| `ranker/pipeline.js` | `ensureEmbeddings`, `ensureFitted`, `prepareCandidates` |
| `ranker/cli.js` | CLI: embed / refit / select / simulate / eval / inspect |
| `config.json` (`ranker` key) | All tunable knobs (priors, epsilon, halfLife, dedupe, slots, …) |
