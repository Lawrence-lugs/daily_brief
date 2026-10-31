#!/usr/bin/env python3
"""CLI entry point for simulation framework."""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulate.core.pool import PoolProvider
from simulate.core.config import load_config, merge_config, freshness_config_summary
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine
from simulate.experiments.runner import (
    compare_engines,
    monte_carlo,
    parameter_sweep,
    ablation_study,
    DEFAULT_OUTPUT_DIR,
)


def main():
    parser = argparse.ArgumentParser(description="Simulation framework for daily brief engines")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # Common args
    def add_common(p):
        p.add_argument("--date", default="2026-10-29", help="Date (YYYY-MM-DD)")
        p.add_argument("--db", default="daily_brief.db", help="Database path")
        p.add_argument("--output", default=DEFAULT_OUTPUT_DIR, help="Output directory")
        p.add_argument("--seeds", default="1-10", help="Seed range (e.g., 1-10 or 1,2,3)")
        p.add_argument("--config", default="config.json", help="Config file")
    
    # compare command
    p_compare = subparsers.add_parser("compare", help="Compare engines")
    add_common(p_compare)
    p_compare.add_argument("--engines", default="keyword,lr", help="Engines to compare (comma-separated)")
    
    # monte-carlo command
    p_mc = subparsers.add_parser("monte-carlo", help="Run Monte Carlo simulation")
    add_common(p_mc)
    p_mc.add_argument("--engine", choices=["keyword", "lr"], required=True, help="Engine to test")
    p_mc.add_argument("--runs", type=int, default=200, help="Number of runs")
    
    # sweep command
    p_sweep = subparsers.add_parser("sweep", help="Parameter sweep")
    add_common(p_sweep)
    p_sweep.add_argument("--engine", choices=["keyword", "lr"], required=True)
    p_sweep.add_argument("--param", action="append", required=True, help="Param=values (e.g., epsilon=0.1,0.25,0.5)")
    p_sweep.add_argument("--metric", default="explore_rate", help="Metric to optimize")
    
    # ablation command
    p_abl = subparsers.add_parser("ablation", help="Ablation study")
    add_common(p_abl)
    p_abl.add_argument("--engine", choices=["keyword", "lr"], required=True)
    p_abl.add_argument("--features", default="epsilon,shown_decay,rejected_decay,skip_exhausted", help="Features to ablate")
    
    args = parser.parse_args()
    
    # Parse seeds
    if "-" in args.seeds and "," not in args.seeds:
        start, end = map(int, args.seeds.split("-"))
        seeds = list(range(start, end + 1))
    else:
        seeds = [int(s) for s in args.seeds.split(",")]
    
    # Load and merge config
    raw_config = load_config(args.config)
    merged_config = merge_config(raw_config, date=args.date)
    
    # Print freshness hook summary for visibility
    fs = freshness_config_summary(merged_config)
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
    pool = pool_provider.load(args.date, merged_config.get("max_age_days", 120.0), merged_config)
    
    # Initialize engines
    engines = {}
    if "keyword" in args.engines.split(",") if args.command == "compare" else [args.engine]:
        engines["keyword"] = KeywordEngine(merged_config)
    if "lr" in args.engines.split(",") if args.command == "compare" else [args.engine]:
        engines["lr"] = LREngine(project_root=PROJECT_ROOT)
    
    # Run command
    if args.command == "compare":
        selected_engines = [engines[e.strip()] for e in args.engines.split(",") if e.strip() in engines]
        results = compare_engines(
            date=args.date,
            seeds=seeds,
            engines=selected_engines,
            pool_provider=pool_provider,
            config=merged_config,
            output_dir=args.output,
        )
        print(f"\nDone! Ran {len(seeds)} seeds across {len(selected_engines)} engines.")
        
    elif args.command == "monte-carlo":
        engine = engines[args.engine]
        results = monte_carlo(
            engine=engine,
            pool=pool,
            n_runs=args.runs,
            config=merged_config,
            seed_start=seeds[0] if seeds else 1,
            output_dir=args.output,
        )
        print(f"\nDone! Coverage: {results['coverage']:.1%}, Consecutive Jaccard: {results['consecutive_jaccard_mean']:.3f}")
        
    elif args.command == "sweep":
        engine = engines[args.engine]
        param_grid = {}
        for p in args.param:
            name, values_str = p.split("=")
            # Try to parse as JSON values
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
        engine = engines[args.engine]
        feature_flags = {f.strip(): True for f in args.features.split(",")}
        
        results = ablation_study(
            engine=engine,
            pool=pool,
            feature_flags=feature_flags,
            seeds=seeds,
            output_dir=args.output,
        )
        print(f"\nDone! Baseline: {results['baseline_score']:.4f}")
        for abl in results["ablations"]:
            print(f"  Without {abl['disabled_feature']}: {abl['mean_score']:.4f} (delta: {abl['mean_score'] - results['baseline_score']:+.4f})")


if __name__ == "__main__":
    main()