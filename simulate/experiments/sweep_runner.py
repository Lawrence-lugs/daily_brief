"""Sacred experiment: parameter sweep for a selection engine.

Sacred equivalent of the old ``test_params.py`` / ``test_sweep_*.py`` scripts.

Registers input JSONs as resources and records ``db_hash`` as config.
"""
from __future__ import annotations

import hashlib
import importlib.util
import itertools
import pkgutil
from pathlib import Path

if not hasattr(pkgutil, "find_loader"):
    pkgutil.find_loader = importlib.util.find_spec  # type: ignore[attr-defined]

from sacred import Experiment
from sacred.observers import SqlObserver

from simulate.core.pool import PoolProvider
from simulate.core.config import load_config, merge_config
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine
from simulate.core.metrics import MetricsCollector


ex = Experiment("daily_brief_parameter_sweep")

_DEFAULT_SQL_URL = "sqlite:///docs/experiments/runs.db"
ex.observers.append(SqlObserver(_DEFAULT_SQL_URL))

INPUT_RESOURCES = [
    "user/defaults/config.json",
    "user/defaults/sources.json",
    "user/defaults/perfect_samples.json",
    "perfect-samples-new.json",
]


def _file_sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


@ex.config
def cfg():
    date = "2026-10-29"
    db_path = "daily_brief.db"
    config_path = "user/defaults/config.json"
    engine = "lr"
    seeds = [1, 2, 3]
    param_grid = {
        "epsilon": [0.25, 0.5, 0.8],
        "halfLifeDays": [7, 30, 60],
    }
    metric = "explore_rate"

    _db_p = Path(db_path)
    db_hash = _file_sha256(_db_p) if _db_p.exists() else ""


@ex.command
def run(
    date,
    db_path,
    config_path,
    engine,
    seeds,
    param_grid,
    metric,
    db_hash,
    _run,
):
    project_root = Path(__file__).resolve().parent.parent.parent

    for res_name in INPUT_RESOURCES:
        res_path = project_root / res_name
        if res_path.exists():
            _run.add_resource(str(res_path))

    _run.info["db_hash"] = db_hash
    _run.info["db_path"] = db_path

    raw_config = load_config(config_path)
    config = merge_config(raw_config, date=date)

    pool_provider = PoolProvider(db_path)
    pool = pool_provider.load(date, config.get("max_age_days", 120.0), config)

    if engine == "keyword":
        eng = KeywordEngine(config)
    else:
        eng = LREngine(project_root=str(project_root))

    param_names = list(param_grid.keys())
    param_values = list(param_grid.values())
    combinations = list(itertools.product(*param_values))

    print(f"Testing {len(combinations)} parameter combinations...")

    results = []
    best_score = -1.0
    best_params = None

    for combo in combinations:
        params = dict(zip(param_names, combo))
        print(f"  {params}...")

        scores = []
        for seed in seeds:
            run_cfg = {"seed": seed, **params}
            try:
                selections = eng.select(pool, run_cfg, seed)
                if metric == "explore_rate":
                    all_picks = []
                    for desk_items in selections.values():
                        all_picks.extend(desk_items)
                    explore = sum(1 for p in all_picks if p.get("mode") == "explore")
                    score = explore / len(all_picks) if all_picks else 0
                elif metric == "mean_age":
                    all_picks = []
                    for desk_items in selections.values():
                        all_picks.extend(desk_items)
                    ages = [p.get("age_days", 0) for p in all_picks if p.get("age_days") is not None]
                    score = -sum(ages) / len(ages) if ages else 0
                else:
                    score = 0
                scores.append(score)
            except Exception as e:
                print(f"    Error: {e}")
                scores.append(float("-inf"))

        avg_score = sum(scores) / len(scores) if scores else float("-inf")
        results.append({"params": params, "scores": scores, "mean_score": avg_score})

        if avg_score > best_score:
            best_score = avg_score
            best_params = params

    result = {
        "engine": eng.name,
        "param_grid": param_grid,
        "metric": metric,
        "seeds": seeds,
        "results": results,
        "best_params": best_params,
        "best_score": best_score,
    }

    _run.info["best_params"] = best_params
    _run.info["best_score"] = best_score

    return result


__all__ = ["ex", "INPUT_RESOURCES"]
