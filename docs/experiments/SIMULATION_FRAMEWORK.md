# Simulation Framework Design

## Problem
The keyword engine (Python) and LR engine (Node.js) live in different runtimes, making comparative experiments cumbersome:
- Different data loading paths
- Different selection APIs
- Manual comparison scripts needed each time

## Solution: Unified Simulation Framework

### Core Abstractions

```
simulate/
├── core/
│   ├── engine.py/js         # Abstract Engine interface
│   ├── pool.py/js           # PoolProvider: load from DB or generate synthetic
│   ├── metrics.py/js        # MetricsCollector: overlap, diversity, coverage, freshness
│   └── reporter.py/js       # Reporter: JSON, HTML, console
├── engines/
│   ├── keyword_engine.py    # Wraps selection.py (Python)
│   ├── lr_engine.py         # Calls node ranker/cli.js select (Node)
│   └── base_engine.py       # Common interface
├── experiments/
│   ├── compare.py           # compare_engines(date, seeds, engines)
│   ├── sweep.py             # parameter_sweep(grid, metric)
│   ├── ablation.py          # ablation_study(engine, features)
│   └── monte_carlo.py       # monte_carlo(engine, n_runs, metrics)
└── viz/
    ├── charts.js            # Chart.js visualizations
    └── report.py            # HTML report generator
```

### Engine Interface (Python & JS)

```python
# Python (simulate/core/engine.py)
from abc import ABC, abstractmethod
from typing import List, Dict, Any

class Engine(ABC):
    @abstractmethod
    def select(self, pool: List[Dict], config: Dict, seed: int) -> Dict[str, List[Dict]]:
        """Return {desk: [items]} for primary and science desks"""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        pass

class KeywordEngine(Engine):
    def select(self, pool, config, seed):
        # Import and call selection.py logic
        from src.selection import pick_desk, pick_reserves
        # ... implementation
        return {"primary": [...], "science": [...]}

    @property
    def name(self): return "keyword"

class LREngine(Engine):
    def select(self, pool, config, seed):
        # Subprocess call to node ranker/cli.js select
        import subprocess, json
        result = subprocess.run(["node", "ranker/cli.js", "select", ...], capture_output=True)
        # Merge with pool data
        return {"primary": [...], "science": [...]}

    @property
    def name(self): return "lr"
```

```javascript
// JS (simulate/core/engine.js) - for Node-based experiments
class Engine {
  async select(pool, config, seed) { throw new Error("Not implemented"); }
  get name() { throw new Error("Not implemented"); }
}

class LREngine extends Engine {
  async select(pool, config, seed) {
    // Direct module import, no subprocess
    const { selectBrief } = require('../ranker/sampler.js');
    // ... implementation
    return { primary: [...], science: [...] };
  }
  get name() { return "lr"; }
}
```

### Pool Provider

```python
class PoolProvider:
    def __init__(self, db_path: str = "daily_brief.db"):
        self.db_path = db_path

    def load(self, date: str, max_age_days: int = 120) -> List[Dict]:
        # Load from SQLite, compute age_days, apply same-day adjustments
        pass

    def synthetic(self, n: int = 1000) -> List[Dict]:
        # Generate synthetic pool for testing
        pass
```

### Metrics Collector

```python
class MetricsCollector:
    @staticmethod
    def jaccard(set_a: Set, set_b: Set) -> float:
        return len(set_a & set_b) / len(set_a | set_b) if (set_a | set_b) else 0

    @staticmethod
    def diversity(items: List[Dict], key: str) -> Dict:
        from collections import Counter
        return dict(Counter(i.get(key) for i in items))

    @staticmethod
    def freshness(items: List[Dict]) -> Dict:
        ages = [i.get("age_days", 0) for i in items]
        return {"mean": mean(ages), "median": median(ages), "max": max(ages)}

    @staticmethod
    def coverage(all_items: List[Dict], picked_items: List[Dict]) -> float:
        all_ids = {i["id"] for i in all_items}
        picked_ids = {i["id"] for i in picked_items}
        return len(picked_ids) / len(all_ids) if all_ids else 0
```

### Experiment Runner

```python
def compare_engines(date: str, seeds: List[int], engines: List[Engine], pool_provider: PoolProvider) -> Dict:
    """Run comparison and return aggregated results"""
    pool = pool_provider.load(date)
    results = {"date": date, "seeds": seeds, "engines": [e.name for e in engines], "runs": []}

    for seed in seeds:
        run = {"seed": seed, "selections": {}}
        for engine in engines:
            selection = engine.select(pool, config, seed)
            run["selections"][engine.name] = selection
        run["comparison"] = compare_selections(run["selections"])
        results["runs"].append(run)

    return aggregate(results)

def monte_carlo(engine: Engine, pool: List[Dict], n_runs: int, seed_start: int = 1) -> Dict:
    """Run engine n_times with different seeds, track stability"""
    ever_picked = set()
    consecutive_jaccards = []
    prev_picks = None

    for i in range(n_runs):
        seed = seed_start + i
        selection = engine.select(pool, config, seed)
        picks = {item["id"] for desk in selection.values() for item in desk}
        ever_picked.update(picks)

        if prev_picks:
            consecutive_jaccards.append(MetricsCollector.jaccard(prev_picks, picks))
        prev_picks = picks

    return {
        "runs": n_runs,
        "pool_size": len(pool),
        "ever_picked": len(ever_picked),
        "coverage": len(ever_picked) / len(pool),
        "consecutive_jaccard_mean": mean(consecutive_jaccards) if consecutive_jaccards else 0,
    }
```

### Visualization (HTML + Chart.js)

The HTML report generator creates:
- Source type distribution (bar chart)
- Age distribution (histogram)
- Cluster coverage (bar chart)
- Selection mode (doughnut chart)
- Model probability distributions
- Time-series tracking (for longitudinal studies)

### Usage

```bash
# Quick comparison
python -m simulate.experiments.compare --date 2026-10-29 --seeds 1..10

# Full sweep
python -m simulate.experiments.sweep --param epsilon --values 0.1,0.25,0.5 --metric jaccard

# Monte Carlo stability
python -m simulate.experiments.monte_carlo --engine lr --runs 500 --date 2026-10-29

# Generate HTML report
python -m simulate.viz.report --input results.json --output report.html
```

## Implementation Priority

1. **Phase 1** (Done): Ad-hoc comparison scripts in `experiments/`
2. **Phase 2**: Create `simulate/` package with core abstractions
3. **Phase 3**: Implement `KeywordEngine` and `LREngine` with unified interface
4. **Phase 4**: Add `PoolProvider` with synthetic data generation
5. **Phase 5**: Build experiment runners (compare, sweep, ablation, monte_carlo)
6. **Phase 6**: HTML report generator with Chart.js

## Benefits

- **Single command** runs full comparison across any engines
- **Reproducible**: seeds, config, pool state all captured
- **Extensible**: new engines just implement the interface
- **Statistically rigorous**: built-in aggregation, confidence intervals
- **Visual by default**: HTML reports with interactive charts
- **Cross-language**: Python for analysis, Node for LR engine (or port LR to Python)