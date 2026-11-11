"""Sacred experiment: ablation study for a selection engine.

Sacred equivalent of ad-hoc ablation experiment scripts.

Registers input JSONs as resources and records ``db_hash`` as config.
"""
from __future__ import annotations

import hashlib
import importlib.util
import math
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


ex = Experiment("daily_brief_ablation")

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
    seeds = [1, 2, 3, 4, 5]
    features = "epsilon,shown_decay,rejected_decay,skip_exhausted"

    _db_p = Path(db_path)
    db_hash = _file_sha256(_db_p) if _db_p.exists() else ""


@ex.command
def run(date, db_path, config_path, engine, seeds, features, db_hash, _run):
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

    feature_list = [f.strip() for f in features.split(",")]
    feature_flags = {f: True for f in feature_list}

    def entropy_score(selections):
        all_picks = []
        for desk_items in selections.values():
            all_picks.extend(desk_items)
        types = Counter(p.get("source_type") for p in all_picks)
        total = sum(types.values())
        if total == 0:
            return 0
        return -sum((c / total) * math.log(c / total) for c in types.values() if c > 0)

    # Baseline (all features enabled)
    baseline_scores = []
    for seed in seeds:
        try:
            selections = eng.select(pool, config, seed)
            baseline_scores.append(entropy_score(selections))
        except Exception as e:
            print(f"  Baseline seed {seed} error: {e}")
            baseline_scores.append(0)
    baseline = sum(baseline_scores) / len(baseline_scores) if baseline_scores else 0

    ablations = []
    for feature in feature_list:
        run_cfg = {f: v for f, v in feature_flags.items()}
        run_cfg[feature] = False
        scores = []
        for seed in seeds:
            try:
                selections = eng.select(pool, run_cfg, seed)
                scores.append(entropy_score(selections))
            except Exception as e:
                print(f"  Without {feature} seed {seed} error: {e}")
                scores.append(0)
        ablations.append({
            "disabled_feature": feature,
            "scores": scores,
            "mean_score": sum(scores) / len(scores) if scores else 0,
        })

    result = {
        "engine": eng.name,
        "feature_flags": feature_flags,
        "baseline_score": baseline,
        "ablations": ablations,
        "seeds": seeds,
    }

    _run.info["baseline_score"] = baseline

    return result


__all__ = ["ex", "INPUT_RESOURCES"]
