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
| `desks.[*].meanP` | Mean model like-probability of picks (per desk) |
| `desks.[*].meanAgeDays` | Mean age of picked items (per desk) |
| `desks.[*].exploreFrac` | Fraction of picks that were explore-mode (per desk) |
| `desks.[*].distinctClusters` | Mean number of distinct clusters represented across picks (per desk) |
| `topIncluded[15]` | Most frequently picked items (`id`, `freq`, `p`, `age`, `title`) |

### Interpretation targets

| Metric | Good range | What it means |
|--------|-----------|---------------|
| `consecutiveJaccard` | well below 1 (e.g. < 0.6) | Briefs change day-to-day; not stuck on the same items |
| `distinctClusters` (per desk) | > 1 | Round-robin is hitting multiple clusters, not one |
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

## 3. Sacred Experiments (replacing ad-hoc scripts)

All experiment scripts have been rewritten as [Sacred](https://sacred.readthedocs.io/) experiments
in `simulate/experiments/`. Each old standalone script corresponds to one sacred `Experiment`,
run through the unified CLI:

| Sacred experiment | CLI command | Replaces |
|-------------------|-------------|----------|
| `daily_brief_engine_comparison` | `python -m simulate.cli sacred` / `compare` | `compare_lr_vs_keyword.py` |
| `daily_brief_parameter_sweep` | `python -m simulate.cli sweep` | `test_params.py`, `test_sweep_*.py` |
| `daily_brief_monte_carlo` | `python -m simulate.cli monte-carlo` | ad-hoc Monte Carlo scripts |
| `daily_brief_ablation` | `python -m simulate.cli ablation` | ad-hoc ablation scripts |

The old `experiments/` folder scripts (`compare_experiments.py`, `compare_experiments2.py`,
`test_*.py`, etc.) have been removed — every experiment now goes through Sacred.

Each Sacred experiment:

- **Config** — all experiment parameters (`date`, `seeds`, `engine`, `db_path`, `config_path`,
  `output_dir`, ...) plus `db_hash`, a SHA-256 of the SQLite database file, so any change to
  DB state produces a distinct config value.
- **Resources** — all input JSON files are snapshotted as sacred resources:
  `user/defaults/config.json`, `user/defaults/sources.json`, `user/defaults/perfect_samples.json`, `perfect-samples-new.json`,
  `state.json` (missing files are skipped gracefully).
- **Artefacts** — generated comparison JSON/HTML reports are attached to each run.
- **Runs** — persisted by a `SqlObserver` (SQLAlchemy) in `docs/experiments/runs.db`
  (SQLite by default; override with `--sql-url <connection-string>`).

### Running a Sacred experiment

```bash
# Compare keyword vs LR (default: keyword engine, seeds 1-10)
python -m simulate.cli sacred
python -m simulate.cli compare  # alias for the same experiment

# Custom date, seeds, engines
python -m simulate.cli sacred --date 2026-10-29 --seeds 1-10 --engines keyword,lr

# Parameter sweep
python -m simulate.cli sweep --engine lr --param "epsilon=0.25,0.5,0.8" --seeds 1-5

# Monte Carlo stability simulation
python -m simulate.cli monte-carlo --engine keyword --runs 100

# Ablation study
python -m simulate.cli ablation --engine lr --seeds 1-5

# Use a different SQL database (e.g. PostgreSQL)
python -m simulate.cli sacred --sql-url postgresql://user:pass@localhost/daily_brief

# Run without any sacred observer (quick tests, nothing persisted)
python -m simulate.cli sacred --unobserved

# Programmatic use
from simulate.experiments.sacred_runner import ex as compare_ex
compare_ex.run(config_updates={"seeds": [1, 2, 3]})
```

### Browse past runs

Sacred stores each run as a row in the `run` table of `docs/experiments/runs.db`,
with related tables `resource` (snapshotted input JSONs), `artifact` (comparison
JSON/HTML reports), `experiment`, `host`, and `dependency`.

| Table | Meaning |
|-------|---------|
| `run` | One row per experiment run: `run_id`, `status`, `command`, `config` (JSON incl. `db_hash`), `info`, `stop_time` |
| `resource` | Input JSON files (`user/defaults/config.json`, `user/defaults/sources.json`, etc.) stored as blobs |
| `artifact` | Generated comparison JSON/HTML reports stored as blobs |

Sacred's own CLI (`python -m sacred ...`) can also be used to query and compare runs.

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

1. **`simulate --set ...`** — tune `epsilon`, `halfLifeDays`, `dedupe.*`, `explore.gamma`, `stories_per_desk`.
   Targets: `consecutiveJaccard` well below 1, `distinctClusters` > 1 per desk.
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

### Baseline before the as-of-cut eval split (2026-11-01)

Recorded on the code before the eval split fix (train=165, test=38, testFrac=0.2). The fix changes these numbers.

| Model | AUC | logLoss |
|-------|-----|---------|
| prior only | 0.6250 | 0.4893 |
| keyword rel | 0.9412 | 1.5875 |
| fitted | 0.5882 | 0.3579 |

Re-run after the split fix (same data): `[eval] cut=2026-10-31 liked before cut=27` (28 liked or saved in total, so one like on the cut date is excluded from interests). Metrics are unchanged to four decimals, so the fix had no measurable effect on this snapshot. Note: `getLikedIds` / `getLikedWithDates` receive `cfg.interests.maxLikedDays` (100) as a date cutoff, so the "last N days" window is not applied (pre-existing bug, not fixed here).

---

## 6. Related Docs

| Topic | File |
|-------|------|
| Project architecture & call paths | `docs/architecture.md` |
| Bayesian LR + Ward clustering model | `docs/model.md` |
| Electron / Obsidian / Web usage | `docs/interfaces.md` |
| SQLite-based stateful logging | `docs/sqlite-logging.md` |
| Ranker CLI reference (full command list) | `ranker/README.md` |
| Full tunable configuration | `user/defaults/config.json` (`ranker` key) |
| Simulation framework design (planned) | `experiments/SIMULATION_FRAMEWORK.md` |
