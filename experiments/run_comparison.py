"""Experiment harness entry point: run engine comparisons with freshness config.

Wires together the simulate framework (PoolProvider, engines, MetricsCollector,
Reporter) and runs compare_engines / parameter_sweep / monte_carlo from the
command line. Records the freshness calculation hook and config hyperparameters
in the output so results are fully reproducible.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulate.core.pool import PoolProvider
from simulate.core.metrics import MetricsCollector
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine
from simulate.experiments.runner import (
    compare_engines,
    monte_carlo,
    parameter_sweep,
    ablation_study,
)


def load_config(config_path: str) -> dict:
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


def build_merged_config(raw: dict) -> dict:
    """Merge ranker + selection + sampling config sections into one flat config.

    The freshness hook and its hyperparameters live in:
      - ranker.sampling.*          (LR engine: epsilon, halfLifeDays,
                                   freshness.model/steepness, dedupe.*,
                                   explore.*, slots.*)
      - selection.*                (Keyword engine: a50_days, slope,
                                   age_floor_days, explore_gamma, etc.)
    """
    ranker = raw.get("ranker", {})
    selection = raw.get("selection", {})
    sampling = ranker.get("sampling", {})
    merged = {**ranker, **selection, **sampling}
    merged["date"] = merged.get("date", "2026-10-29")
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run engine comparison experiments with freshness config tracking"
    )
    parser.add_argument("--date", default="2026-10-29", help="Date (YYYY-MM-DD)")
    parser.add_argument("--db", default="daily_brief.db", help="Database path")
    parser.add_argument("--config", default="config.json", help="Config file")
    parser.add_argument("--output", default="experiments/output", help="Output directory")
    parser.add_argument("--seeds", default="1-10", help="Seed range (e.g., 1-10 or 1,2,3)")
    parser.add_argument("--engines", default="keyword,lr", help="Engines to compare (comma-separated)")
    parser.add_argument("--command", choices=["compare", "sweep", "monte-carlo", "ablation"],
                        default="compare", help="Experiment command to run")
    parser.add_argument("--engine", choices=["keyword", "lr"], help="Engine for sweep/mc/ablation")
    parser.add_argument("--param", action="append", help="Param=values for sweep (e.g., epsilon=0.1,0.25,0.5)")
    parser.add_argument("--metric", default="mean_age", help="Metric for sweep")
    parser.add_argument("--runs", type=int, default=200, help="Runs for monte-carlo")
    parser.add_argument("--features", default="epsilon,halfLifeDays,explore.gamma",
                        help="Features for ablation")

    args = parser.parse_args()

    # Parse seeds
    if "-" in args.seeds and "," not in args.seeds:
        start, end = map(int, args.seeds.split("-"))
        seeds = list(range(start, end + 1))
    else:
        seeds = [int(s) for s in args.seeds.split(",")]

    # Load and merge config
    raw_config = load_config(args.config)
    config = build_merged_config(raw_config)
    config["date"] = args.date

    # Print freshness hook summary for visibility
    fs = MetricsCollector.freshness_config_summary(config)
    print("=== Freshness Configuration ===")
    if "lr_freshness" in fs:
        lr = fs["lr_freshness"]
        print(f"LR model: {lr['model']} | halfLifeDays={lr['halfLifeDays']} | "
              f"steepness={lr['steepness']:.4f} | epsilon={lr['epsilon']}")
    if "keyword_freshness" in fs:
        kw = fs["keyword_freshness"]
        print(f"Keyword model: {kw['model']} | a50_days={kw['a50_days']} | "
              f"slope={kw['slope']} | epsilon={kw['epsilon']}")
    print("===============================")

    # Initialize pool provider
    pool_provider = PoolProvider(args.db)
    pool = pool_provider.load(args.date, config.get("max_age_days", 120.0), config)
    print(f"Loaded pool: {len(pool)} items")

    # Initialize engines
    engines = []
    engine_names = [e.strip() for e in args.engines.split(",") if e.strip()]
    if "keyword" in engine_names:
        engines.append(KeywordEngine(config))
    if "lr" in engine_names:
        engines.append(LREngine(project_root=PROJECT_ROOT))

    if args.command == "compare":
        selected = [e for e in engines if e.name in engine_names]
        results = compare_engines(
            date=args.date,
            seeds=seeds,
            engines=selected,
            pool_provider=pool_provider,
            config=config,
            output_dir=args.output,
        )
        print(f"\nDone! Ran {len(seeds)} seeds across {len(selected)} engines.")
        print(f"Results saved to {args.output}/")

    elif args.command == "monte-carlo":
        engine = next(e for e in engines if e.name == args.engine)
        results = monte_carlo(
            engine=engine,
            pool=pool,
            n_runs=args.runs,
            config=config,
            seed_start=seeds[0],
            output_dir=args.output,
        )
        print(f"\nDone! Coverage: {results['coverage']:.1%}, "
              f"Consecutive Jaccard: {results['consecutive_jaccard_mean']:.3f}")

    elif args.command == "sweep":
        engine = next(e for e in engines if e.name == args.engine)
        param_grid = {}
        for p in (args.param or []):
            name, values_str = p.split("=")
            try:
                values = json.loads(f"[{values_str}]")
            except json.JSONDecodeError:
                values = [v.strip() for v in values_str.split(",")]
            param_grid[name] = values
        results = parameter_sweep(
            engine=engine,
            pool=pool,
            param_grid=param_grid,
            metric=args.metric,
            seeds=seeds,
            output_dir=args.output,
        )
        print(f"\nDone! Best params: {results['best_params']} (score: {results['best_score']:.4f})")

    elif args.command == "ablation":
        engine = next(e for e in engines if e.name == args.engine)
        feature_flags = {f.strip(): True for f in args.features.split(",")}
        results = ablation_study(
            engine=engine,
            pool=pool,
            feature_flags=feature_flags,
            seeds=seeds,
            output_dir=args.output,
        )
        print(f"\nDone! Baseline: {results['baseline_score']:.4f}")


if __name__ == "__main__":
    main()
