# Simulation Framework - Results Summary

## Overview
The simulation framework (`simulate/`) provides a unified interface for comparing the **Keyword Engine** (legacy Python) and **LR Engine** (Node.js) selection engines. It includes:

- **Core abstractions**: Engine interface, PoolProvider, MetricsCollector, Reporter
- **Engine implementations**: KeywordEngine, LREngine (subprocess-based)
- **Experiment runners**: compare, monte_carlo, sweep, ablation
- **Visualization**: HTML reports with Chart.js
- **CLI**: `python simulate/cli.py <command>`

---

## Key Findings (50-seed comparison, 2026-10-29)

### Source Type Distribution
| Source Type | Keyword | LR | Diff |
|-------------|---------|-----|------|
| researchlike | **87.0%** | **99.0%** | +12.0% |
| newslike | **11.9%** | **0.1%** | -11.8% |
| commentary | **1.1%** | **0.9%** | -0.2% |

**Key insight**: LR engine heavily favors research papers due to model weight `+0.706` for `type:researchlike` and `-0.551` for `type:newslike`.

### Freshness (age_days)
| Desk | Keyword (mean/median) | LR (mean/median) |
|------|----------------------|------------------|
| Primary | 6.7 / 1.3 | **1.5 / 1.3** |
| Science | 5.0 / 1.3 | **1.7 / 1.3** |
| **Overall** | 2.6 / 1.3 | **1.6 / 1.3** |

LR picks fresher items on average due to value function `V = p × exp(-λA) × dedupe(days_since_shown)`.

### Selection Overlap (Jaccard)
| Desk | Jaccard |
|------|---------|
| Primary | **0.0128** (near zero) |
| Science | **0.0063** (near zero) |
| All | **0.0564** (very low) |

**Engines pick almost completely disjoint sets.**

### Stability (Consecutive Jaccard across seeds)
| Engine | Mean | Median | Range |
|--------|------|--------|-------|
| Keyword | 0.752 | 0.750 | 0.667 - 0.892 |
| LR | **0.894** | **0.905** | 0.818 - 0.967 |

LR is **more stable** (higher consecutive overlap) due to cluster round-robin guaranteeing 5/5 core clusters in primary desk.

### Exploration Rate
| Desk | Keyword | LR |
|------|---------|-----|
| Primary | **28.8%** | 4.0% |
| Science | **23.6%** | 4.7% |

LR explores less because round-robin + high model scores for core clusters leaves little room for exploration.

### LR Cluster Coverage (50 seeds)
| Cluster | Core/Side | Picks |
|---------|-----------|-------|
| 0 | core | 57 |
| 1 | core | 66 |
| 2 | core | 463 |
| 3 | core | 360 |
| 4 | core | 554 |
| 5 | side | 1,081 |
| 6 | side | 259 |
| 7 | side | 160 |

Core clusters 2, 3, 4 dominate (most items). Cluster 1 and 0 are small (1-2 items each, perfect samples).

---

## Monte Carlo Simulation (LR Engine, 500 runs)

| Metric | Value |
|--------|-------|
| Pool size | 2,902 |
| Items ever picked | 911 |
| **Pool coverage** | **31.4%** |
| Consecutive Jaccard (mean) | 0.895 |
| Consecutive Jaccard (median) | 0.905 |

### Top Consistently Picked Items (all 500 runs)
All 25 items from the primary desk core clusters are picked **100% of the time** (5 items × 5 core clusters = 25 guaranteed picks per run).

---

## Framework Architecture

```
simulate/
├── core/
│   ├── engine.py      # Abstract Engine interface + SelectionResult
│   ├── pool.py        # PoolProvider (SQLite + synthetic)
│   ├── metrics.py     # Jaccard, diversity, freshness, coverage
│   └── reporter.py    # JSON, HTML (Chart.js), console
├── engines/
│   ├── keyword_engine.py  # Wraps src.selection logic
│   └── lr_engine.py       # Calls node ranker/cli.js select
├── experiments/
│   └── runner.py      # compare, monte_carlo, sweep, ablation
├── viz/               # (reporter handles viz)
└── cli.py             # Command-line entry point
```

---

## Usage Examples

```bash
# Quick comparison (5 seeds)
python simulate/cli.py compare --seeds 1-5 --engines keyword,lr

# Full comparison (50 seeds)
python simulate/cli.py compare --seeds 1-50 --engines keyword,lr

# Monte Carlo stability test
python simulate/cli.py monte-carlo --engine lr --runs 500

# Parameter sweep
python simulate/cli.py sweep --engine keyword --param epsilon=0.1,0.25,0.5 --metric explore_rate

# Ablation study
python simulate/cli.py ablation --engine keyword --features epsilon,shown_decay,rejected_decay
```

---

## Programmatic Usage

```python
from simulate import (
    PoolProvider, KeywordEngine, LREngine,
    compare_engines, monte_carlo, parameter_sweep, ablation_study
)

pool_provider = PoolProvider("daily_brief.db")
kw_engine = KeywordEngine(selection_config, desk_config)
lr_engine = LREngine(project_root=".")

# Compare engines
results = compare_engines(
    date="2026-10-29",
    seeds=list(range(1, 51)),
    engines=[kw_engine, lr_engine],
    pool_provider=pool_provider,
    config=ranker_config,
)

# Monte Carlo
pool = pool_provider.load("2026-10-29")
mc = monte_carlo(lr_engine, pool, n_runs=500, config=ranker_config)

# Parameter sweep
sweep = parameter_sweep(kw_engine, pool, {"epsilon": [0.1, 0.25, 0.5]}, metric="explore_rate")

# Ablation
ablation = ablation_study(kw_engine, pool, {
    "epsilon": True,
    "shown_decay": True,
    "rejected_decay": True,
    "skip_exhausted_subtopics": True,
})
```

---

## Key Design Decisions

1. **Cross-language via subprocess**: LR engine calls Node.js CLI (not direct import) to avoid Python/JS bridge complexity.

2. **PoolProvider loads for Keyword only**: LR engine loads its own data (embeddings, model, interests) from DB. Pool is used only for metadata merge.

3. **Desk config from sources.json**: Subtopics per desk are loaded from sources.json, not hardcoded.

4. **Same-day adjustment**: Pool provider subtracts same-day shown/rejected counts (matches brief.py behavior).

5. **Chart.js for visualization**: No Python plotting dependencies - HTML reports work in any browser.

---

## Next Steps (per SIMULATION_FRAMEWORK.md)

- [x] Phase 2: Core abstractions (engine, pool, metrics, reporter)
- [x] Phase 3: KeywordEngine + LREngine with unified `select()` API
- [x] Phase 4: PoolProvider with synthetic data generation
- [x] Phase 5: Experiment runners (compare, sweep, ablation, monte_carlo)
- [x] Phase 6: HTML report generator with Chart.js
- [ ] Add confidence intervals to aggregate metrics
- [ ] Longitudinal tracking (compare across dates)
- [ ] Port LR engine to Python for true in-process comparison
- [ ] Add synthetic data generator for controlled experiments