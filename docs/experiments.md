# Experiments & Simulate Functionality

This document describes how to run experiments and Monte-Carlo simulations for the Daily Brief selection engines,
and how the `simulate` command (in the ranker CLI) and the `experiments/` folder fit together.

Read alongside: `docs/model.md` (model details), `ranker/README.md` (CLI reference), and `docs/architecture.md`
(call paths).

---

## 1. The `simulate` Command (ranker CLI)

`node ranker/cli.js simulate --date D [--runs N] [--seed N] [--set a.b=v ...]`

- **Ephemeral Monte-Carlo preview** — no LLM, no fetch, **no DB writes**.
- Loads candidates via `prepareCandidates`, runs `selectBrief` N times with different `mulberry32` seeds, and
  aggregates stability metrics.
- Use `--set` to override config at runtime (e.g. `--set sampling.epsilon=0.1 --set sampling.halfLifeDays=14`).

### Output (JSON to stdout)

| Field | Meaning |
|-------|---------|
| `runs` | Number of Monte-Carlo runs |
| `candidates` | Number of candidate items scored |
| `everPicked` | Count of distinct items picked across all runs |
| `consecutiveJaccard` | Mean Jaccard similarity between consecutive runs (1 = identical brief every day, 0 = disjoint) |
| `desks.[primary\|science].meanP` | Mean model like-probability of picks |
| `desks.[primary\|science].meanAgeDays` | Mean age of picked items |
| `desks.[primary\|science].exploreFrac` | Fraction of picks that were explore-mode |
| `desks.[primary\|science].distinctClusters` | Mean number of distinct clusters represented across picks |
| `topIncluded[15]` | Most frequently picked items (`id`, `freq`, `p`, `age`, `title`) |

### Interpretation targets

| Metric | Good range | What it means |
|--------|-----------|---------------|
| `consecutiveJaccard` | well below 1 (e.g. < 0.6) | Briefs change day-to-day; not stuck on the same items |
| `distinctClusters` (primary) | > 1 | Round-robin is hitting multiple core clusters, not one |
| `exploreFrac` | ~ epsilon | Exploration is happening as configured |

### Example

```bash
# Baseline simulation
node ranker/cli.js simulate --date 2026-10-29 --runs 200 --seed 1

# Sweep epsilon
node ranker/cli.js simulate --runs 200 --set sampling.epsilon=0.1
node ranker/cli.js simulate --runs 200 --set sampling.epsilon=0.25
node ranker/cli.js simulate --runs 200 --set sampling.epsilon=0.5

# More exploration, longer freshness
node ranker/cli.js simulate --runs 200 --set sampling.epsilon=0.3 --set sampling.halfLifeDays=14
```

### Safety

`simulate` uses `ensureFitted({persist:false})` — it fits the model in memory only and writes nothing to the DB.
The database is byte-identical before and after a simulate run (WAL checkpointed).

---

## 2. `eval` Command (Chronological Holdout)

`node ranker/cli.js eval [--testFrac F]`  (default `--testFrac 0.2`)

- Splits the cross-fitted training set chronologically (older = train, newer = test) via `trainer.chronoSplit`.
- Fits `SparseBayesLogReg` on train, reports **AUC** and **logLoss** on test for three models:
  1. **prior only** (no training data — the cold-start baseline)
  2. **keyword `rel`** (the legacy keyword relevance as a score)
  3. **fitted** (the Bayesian LR model)

- AUC returns `NaN` when there are no positive or negative examples in the test split (early days, before enough
  likes). In that case only check that `eval` does not crash and that fitted equals prior with zero examples.

### Example

```bash
node ranker/cli.js eval --testFrac 0.2
# → AUC/logLoss for {prior-only, keyword rel, fitted} on chronological holdout
```

Use `eval` to tune `model.prior.rules` (per-feature Gaussian precision). Target: fitted ≥ prior-only once you have
≥ ~30 positives.

---

## 3. `experiments/` Folder (Ad-Hoc Comparison Scripts)

The `experiments/` directory contains Python scripts for running comparative experiments between the keyword and LR
engines. These are ad-hoc tools, not a formal package.

| File | Purpose |
|------|---------|
| `run_comparison.py` | Compare engines on a given date/seeds |
| `make_report.py` / `gen_report.py` | Generate comparison reports |
| `write_report.py` | Write report output |
| `SIMULATION_FRAMEWORK.md` | Design doc for a unified simulation framework (planned, not implemented) |
| `results/` | JSON output from past runs (`comparison_*.json`, `aggregated_*.json`) |
| `comparison_report.html` | HTML report from a past run |

### Running a comparison

```bash
# Example (adapt arguments to the script)
python experiments/run_comparison.py --date 2026-10-29 --seeds 1..10
python experiments/make_report.py --input results/aggregated_*.json --output experiments/comparison_report.html
```

The design doc (`SIMULATION_FRAMEWORK.md`) describes a future `simulate/` package with:
- `Engine` interface (Python + JS) with `select(pool, config, seed)`
- `KeywordEngine` (wraps `src/selection.py`) and `LREngine` (calls `node ranker/cli.js select`)
- `PoolProvider` (load from DB or generate synthetic)
- `MetricsCollector` (Jaccard overlap, diversity, freshness, coverage)
- Experiment runners: `compare`, `sweep`, `ablation`, `monte_carlo`
- HTML report generator with Chart.js

That package is **planned, not implemented** — the current `experiments/` scripts are the working alternative.

---

## 4. A/B Testing: Keyword vs LR

Both engines can run on the same day (same-day regeneration supersedes). This enables A/B comparison:

```bash
# Keyword (legacy)
python src/brief.py --engine keyword --no-llm --date 2026-10-29

# LR (new)
python src/brief.py --engine lr --no-llm --date 2026-10-29
```

- `meta.engine` is stored in `briefs.meta` and shown in the server dropdown.
- Running keyword then LR on the same day is allowed, but counters/`training_examples` follow the last one — fine
  for a temporary comparison.
- The LR engine falls back to keyword on any error (non-zero exit, invalid JSON, missing node).

### What to compare

| Metric | How |
|--------|-----|
| Brief overlap (Jaccard) | Compare item IDs selected by each engine for the same date/seed |
| Explore fraction | `n_explore` in `briefs.meta` |
| Age distribution | Mean `age_days` of stories |
| Source type mix | `source_type` distribution across stories |
| Like/save rate | Feedback on stories from each engine (longitudinal) |

---

## 5. Tuning Loop

Use `simulate` to tune sampling knobs, then `eval` to tune model priors:

1. **`simulate --set ...`** — tune `epsilon`, `halfLifeDays`, `dedupe.*`, `explore.gamma`, `slots.*`.
   Targets: `consecutiveJaccard` well below 1, `distinctClusters` > 1 for primary.
2. **`eval --testFrac 0.2`** — tune `model.prior.rules` (prec/mean per feature).
   Target: fitted ≥ prior-only on chronological holdout (≥ ~30 positives).
3. **A/B over ~2 weeks** — run both engines, compare like/save rates and overlap.

Typical ranges (from `ranker/README.md`):

| Knob | Typical Range |
|------|---------------|
| `sampling.epsilon` | 0.15–0.35 |
| `sampling.halfLifeDays` | 5–14 |
| `sampling.dedupe.hardWindowDays` | 1–3 |
| `sampling.dedupe.t0` / `scale` | t0=5–10, scale=1–3 |
| `sampling.explore.gamma` | 0.3–0.7 |
| `interests.kappa` | 10–50 |
| `model.prior.rules[].prec` | tune via `eval` |

---

## 6. Related Docs

| Topic | File |
|-------|------|
| Project architecture & call paths | `docs/architecture.md` |
| Bayesian LR + Ward clustering model | `docs/model.md` |
| Electron / Obsidian / Web usage | `docs/interfaces.md` |
| SQLite-based stateful logging | `docs/sqlite-logging.md` |
| Ranker CLI reference (full command list) | `ranker/README.md` |
| Full tunable configuration | `config.json` (`ranker` key) |
| Simulation framework design (planned) | `experiments/SIMULATION_FRAMEWORK.md` |
