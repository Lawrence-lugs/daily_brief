"""Sacred experiment: Monte Carlo stability simulation for a selection engine.

Sacred equivalent of ad-hoc Monte Carlo experiment scripts.

Registers input JSONs as resources and records ``db_hash`` as config.
"""
from __future__ import annotations

import hashlib
import importlib.util
import pkgutil
from collections import Counter
from pathlib import Path

if not hasattr(pkgutil, "find_loader"):
    pkgutil.find_loader = importlib.util.find_spec  # type: ignore[attr-defined]

from sacred import Experiment
from sacred.observers import SqlObserver

from simulate.core.pool import PoolProvider
from simulate.core.config import load_config, merge_config
from simulate.core.metrics import MetricsCollector
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine


ex = Experiment("daily_brief_monte_carlo")

_DEFAULT_SQL_URL = "sqlite:///docs/experiments/runs.db"
ex.observers.append(SqlObserver(_DEFAULT_SQL_URL))

INPUT_RESOURCES = [
    "config.json",
    "sources.json",
    "perfect_samples.json",
    "perfect-samples-new.json",
    "state.json",
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
    config_path = "config.json"
    engine = "lr"
    n_runs = 200
    seed_start = 1

    _db_p = Path(db_path)
    db_hash = _file_sha256(_db_p) if _db_p.exists() else ""


@ex.command
def run(date, db_path, config_path, engine, n_runs, seed_start, db_hash, _run):
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

    ever_picked = set()
    consecutive_jaccards = []
    prev_picks = None
    item_counts = Counter()

    for i in range(n_runs):
        seed = seed_start + i
        if i % 50 == 0:
            print(f"  Run {i + 1}/{n_runs}...")

        try:
            selections = eng.select(pool, config, seed)
            picks = set()
            for desk_items in selections.values():
                for item in desk_items:
                    pid = item.get("id")
                    picks.add(pid)
                    item_counts[pid] += 1
            ever_picked.update(picks)

            if prev_picks is not None:
                consecutive_jaccards.append(MetricsCollector.jaccard(prev_picks, picks))
            prev_picks = picks
        except Exception as e:
            print(f"  Run {i + 1} failed: {e}")

    consecutive = sorted(consecutive_jaccards)
    result = {
        "engine": eng.name,
        "runs": n_runs,
        "pool_size": len(pool),
        "ever_picked": len(ever_picked),
        "coverage": len(ever_picked) / len(pool) if pool else 0,
        "consecutive_jaccard_mean": sum(consecutive_jaccards) / len(consecutive_jaccards) if consecutive_jaccards else 0,
        "consecutive_jaccard_median": consecutive[len(consecutive) // 2] if consecutive else 0,
        "top_items": item_counts.most_common(20),
        "pick_frequency": dict(item_counts),
    }

    _run.info["coverage"] = result["coverage"]
    _run.info["consecutive_jaccard_mean"] = result["consecutive_jaccard_mean"]

    return result


__all__ = ["ex", "INPUT_RESOURCES"]
