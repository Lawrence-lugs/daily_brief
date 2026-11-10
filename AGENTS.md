# AGENTS.md — daily_brief project context & contracts

## Project layout (relevant subset)

```
daily_brief/                      # project root
├── config.json                   # top-level config (ranker section inside)
├── daily_brief.db                # SQLite DB (candidate_pool, stories, embeddings, model_eval, ranker_state)
├── ranker/                       # Node.js ranking engine (ESM)
│   ├── cli.js                    # CLI: select, refit, eval, inspect, pool, simulate
│   ├── pipeline.js               # ensureEmbeddings, ensureFitted, prepareCandidates, evalModel
│   ├── trainer.js                # buildTrainingSet (cross-fitted interests), chronoSplit
│   ├── interests.js              # buildInterests (Ward medoids from perfect + liked)
│   ├── model.js                  # SparseBayesLogReg, auc, logLoss
│   ├── store.js                  # SQLite wrapper (getPool, getLikedIds, getTrainingRows, ...)
│   ├── sampler.js                # selectBrief (cluster round-robin + epsilon-greedy)
│   ├── embedder.js               # embedding models
│   └── ...
├── simulate/                     # Python simulation framework
│   ├── cli.py                    # entry point: `python -m simulate.cli <command>`
│   └── experiments/
│       ├── __init__.py           # exports experiment `ex` objects
│       ├── sacred_runner.py      # keyword vs lr comparison (Sacred)
│       ├── ablation_runner.py    # feature ablation (Sacred)
│       ├── sweep_runner.py       # parameter sweep (Sacred)
│       ├── monte_carlo_runner.py # Monte Carlo stability (Sacred)
│       ├── clustering_ablation.py# NEW: liked-items vs perfect-samples clustering (Sacred)
│       └── eval_clustering_ablation.js  # NEW: Node.js helper for clustering ablation
└── docs/experiments/
    ├── runs.db                   # Sacred SQL observer store
    └── clustering_ablation.qmd   # NEW: standalone quarto report notebook
```

## Contract: where experiment-specific code lives

**Experiment-specific helper scripts live in `simulate/experiments/`, NOT in `ranker/` or the main build.**

- The clustering-ablation Node.js helper is at `simulate/experiments/eval_clustering_ablation.js` (moved out of `ranker/` per this contract).
- It imports ranker modules via `../../ranker/*.js` (project-root-relative), since it now lives one directory deeper.
- The Sacred experiment wrapping it is `simulate/experiments/clustering_ablation.py` (`ex = Experiment("daily_brief_clustering_ablation")`), exported from `simulate/experiments/__init__.py` as `clustering_ablation_ex`, and routed in `simulate/cli.py` under the `clustering-ablation` subcommand.

When adding a new experiment:
1. Put any experiment-specific script under `simulate/experiments/`.
2. Create a Sacred `Experiment` in `simulate/experiments/<name>.py`, register input JSONs as resources, record `db_hash` as config, and return `None` (SqlObserver's `result` column expects a scalar; attach artefacts via `_run.add_artifact`).
3. Export `ex` from `simulate/experiments/__init__.py`.
4. Add a subparser + route in `simulate/cli.py`.

## Running the clustering-ablation experiment

```bash
# From project root. Persists run to docs/experiments/runs.db (Sacred SQL observer).
python -m simulate.cli clustering-ablation --date 2026-11-01 --test-frac 0.2

# Without persisting (useful for quick iteration):
python -m simulate.cli clustering-ablation --date 2026-11-01 --test-frac 0.2 --unobserved

# Programmatic:
from simulate.experiments.clustering_ablation import ex
ex.run(command_name="run", config_updates={"date": "2026-11-01", "test_frac": 0.2})
```

The Node.js helper can also run standalone:
```bash
node simulate/experiments/eval_clustering_ablation.js --date 2026-11-01 --testFrac 0.2
```

## What the clustering ablation measures

Does including liked/saved items in Ward cluster medoid construction change the LR model's AUC/logLoss?

- `liked` (current): perfect samples (weight κ=5) **and** liked items (weight 1) seed medoids
- `perfect` (ablation): perfect samples only

Identical training rows/labels/test split in both conditions; only the medoids (and hence the `n:d1` distance-to-medoid feature) differ. Metric = chronological holdout (80/20 by date) prior / keyword(`rel`) / fitted Bayesian-LR AUC & logLoss.

## Key result (2026-11-01, n_train=165, n_test=50)

| Metric | liked | perfect only | Delta (perfect − liked) |
|--------|-------|--------------|-------------------------|
| Fitted AUC | 0.6977 | 0.7475 | **+0.0498** |
| Fitted logLoss | 0.3800 | 0.3711 | −0.0089 |
| Keyword AUC | 0.8804 | 0.8804 | 0 |

Excluding liked items from clustering **improved** fitted AUC (~0.05) — the opposite of naive expectation. Liked items are recent/personally-salient and pull medoids toward recent tastes, but the chronological holdout is future-dated, so those medoids generalize poorly. Perfect samples are durable anchors. Caveat: test set is small (n≈50); re-run on other dates to confirm significance.

## Standalone report

`docs/experiments/clustering_ablation.qmd` — executable quarto notebook that reads the latest Sacred run from `docs/experiments/runs.db` and renders a results table + Plotly charts (fitted AUC, fitted logLoss, delta). Quarto is not installed in this environment; the notebook executes via Python (plotly/pandas/sqlite3) if rendered through a compatible engine.

## Environment notes

- Node.js v24.19.0, Python 3.14
- `sacred` 0.8.7 with a `pkgutil.find_loader` shim (already applied in each experiment file)
- Sacred runs persist to `docs/experiments/runs.db`; the `run` table joins `experiment` on `experiment_id` (not `experiment.name` directly)
- `daily_brief.db` must exist at project root; embeddings/model must be fitted (the helper calls `ensureEmbeddings`/`ensureFitted`)
