#!/usr/bin/env python3
"""CLI entry point for simulation framework — all subcommands run via Sacred experiments."""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulate.experiments.runner import DEFAULT_OUTPUT_DIR
from simulate.experiments.sacred_runner import ex as compare_ex
from simulate.experiments.sweep_runner import ex as sweep_ex
from simulate.experiments.monte_carlo_runner import ex as monte_carlo_ex
from simulate.experiments.ablation_runner import ex as ablation_ex
from simulate.experiments.clustering_ablation import ex as clustering_ablation_ex


def _parse_seeds(seeds_str: str) -> list[int]:
    if "-" in seeds_str and "," not in seeds_str:
        start, end = map(int, seeds_str.split("-"))
        return list(range(start, end + 1))
    return [int(s) for s in seeds_str.split(",")]


def _configure_observer(ex, sql_url: str | None, unobserved: bool):
    """Attach or clear the SqlObserver on a sacred Experiment."""
    from sacred.observers import SqlObserver

    if unobserved:
        ex.observers.clear()
        return
    if sql_url is not None:
        ex.observers = [
            o for o in ex.observers if not isinstance(o, SqlObserver)
        ]
        ex.observers.append(SqlObserver(sql_url))


def main():
    parser = argparse.ArgumentParser(description="Simulation framework for daily brief engines")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Common args
    def add_common(p):
        p.add_argument("--date", default="2026-10-29", help="Date (YYYY-MM-DD)")
        p.add_argument("--db", default="daily_brief.db", help="Database path")
        p.add_argument("--config", default=str(PROJECT_ROOT / "simulate" / "config" / "config.json"), help="Config file")

    # compare command (= sacred compare_keyword_vs_lr experiment)
    p_compare = subparsers.add_parser("compare", help="Compare engines (Sacred experiment: compare_keyword_vs_lr)")
    add_common(p_compare)
    p_compare.add_argument("--engines", default="keyword,lr", help="Engines to compare (comma-separated)")
    p_compare.add_argument("--seeds", default="1-10", help="Seed range (e.g., 1-10 or 1,2,3)")
    p_compare.add_argument("--output", default=DEFAULT_OUTPUT_DIR, help="Output directory")
    p_compare.add_argument(
        "--sql-url",
        default=None,
        help="SQLAlchemy connection URL for the sacred SQL observer (default: sqlite:///docs/experiments/runs.db)",
    )
    p_compare.add_argument(
        "--unobserved",
        action="store_true",
        help="Run without any sacred observer (no run persisted)",
    )

    # sacred command (alias for compare_keyword_vs_lr)
    p_sacred = subparsers.add_parser("sacred", help="Run compare_keyword_vs_lr Sacred experiment")
    add_common(p_sacred)
    p_sacred.add_argument("--engines", default="keyword,lr", help="Engines to compare (comma-separated)")
    p_sacred.add_argument("--seeds", default="1-10", help="Seed range (e.g., 1-10 or 1,2,3)")
    p_sacred.add_argument("--output", default=DEFAULT_OUTPUT_DIR, help="Output directory")
    p_sacred.add_argument(
        "--sql-url",
        default=None,
        help="SQLAlchemy connection URL for the sacred SQL observer (default: sqlite:///docs/experiments/runs.db)",
    )
    p_sacred.add_argument(
        "--unobserved",
        action="store_true",
        help="Run without any sacred observer (no run persisted)",
    )

    # monte-carlo command
    p_mc = subparsers.add_parser("monte-carlo", help="Monte Carlo stability simulation (Sacred experiment)")
    add_common(p_mc)
    p_mc.add_argument("--engine", choices=["keyword", "lr"], required=True, help="Engine to test")
    p_mc.add_argument("--runs", type=int, default=200, help="Number of runs")
    p_mc.add_argument("--seed-start", type=int, default=1, help="Starting seed")
    p_mc.add_argument("--seeds", default="1", help="Seed range (e.g., 1-5 or 1,2,3)")
    p_mc.add_argument(
        "--sql-url",
        default=None,
        help="SQLAlchemy connection URL for the sacred SQL observer",
    )
    p_mc.add_argument(
        "--unobserved",
        action="store_true",
        help="Run without any sacred observer (no run persisted)",
    )

    # sweep command
    p_sweep = subparsers.add_parser("sweep", help="Parameter sweep (Sacred experiment)")
    add_common(p_sweep)
    p_sweep.add_argument("--engine", choices=["keyword", "lr"], required=True)
    p_sweep.add_argument("--param", action="append", required=True, help="Param=values (e.g., epsilon=0.1,0.25,0.5)")
    p_sweep.add_argument("--metric", default="explore_rate", help="Metric to optimize")
    p_sweep.add_argument("--seeds", default="1-5", help="Seed range (e.g., 1-5 or 1,2,3)")
    p_sweep.add_argument(
        "--sql-url",
        default=None,
        help="SQLAlchemy connection URL for the sacred SQL observer",
    )
    p_sweep.add_argument(
        "--unobserved",
        action="store_true",
        help="Run without any sacred observer (no run persisted)",
    )

    # ablation command
    p_abl = subparsers.add_parser("ablation", help="Ablation study (Sacred experiment)")
    add_common(p_abl)
    p_abl.add_argument("--engine", choices=["keyword", "lr"], required=True)
    p_abl.add_argument("--features", default="epsilon,shown_decay,rejected_decay,skip_exhausted", help="Features to ablate")
    p_abl.add_argument("--seeds", default="1-5", help="Seed range (e.g., 1-5 or 1,2,3)")
    p_abl.add_argument(
        "--sql-url",
        default=None,
        help="SQLAlchemy connection URL for the sacred SQL observer",
    )
    p_abl.add_argument(
        "--unobserved",
        action="store_true",
        help="Run without any sacred observer (no run persisted)",
    )

    # clustering-ablation command
    p_clab = subparsers.add_parser("clustering-ablation", help="Clustering ablation: liked items vs perfect samples only (Sacred experiment)")
    add_common(p_clab)
    p_clab.add_argument(
        "--test-frac",
        type=float,
        default=0.2,
        help="Test fraction for chronological holdout (default: 0.2)",
    )
    p_clab.add_argument(
        "--sql-url",
        default=None,
        help="SQLAlchemy connection URL for the sacred SQL observer",
    )
    p_clab.add_argument(
        "--unobserved",
        action="store_true",
        help="Run without any sacred observer (no run persisted)",
    )

    args = parser.parse_args()

    # Route each command through its Sacred experiment
    if args.command in ("compare", "sacred"):
        _configure_observer(compare_ex, args.sql_url, args.unobserved)
        seeds = _parse_seeds(args.seeds)
        engines_list = [e.strip() for e in args.engines.split(",") if e.strip()]

        print(f"=== Sacred Experiment: daily_brief_engine_comparison ===")
        print(f"Date:        {args.date}")
        print(f"Seeds:       {seeds}")
        print(f"DB path:     {args.db}")
        print(f"Config:      {args.config}")
        print(f"Engines:     {engines_list}")
        print(f"Output dir:  {args.output}")
        sql_url = args.sql_url or "sqlite:///docs/experiments/runs.db"
        print(f"SQL observer: {sql_url}")
        print("========================================================")

        compare_ex.run(
            command_name="run",
            config_updates={
                "date": args.date,
                "seeds": seeds,
                "db_path": args.db,
                "config_path": args.config,
                "output_dir": args.output,
                "engines": engines_list,
            },
        )
        print("\nSacred run complete. See docs/experiments/runs.db for the SQL observer store.")

    elif args.command == "monte-carlo":
        _configure_observer(monte_carlo_ex, args.sql_url, args.unobserved)
        seeds = _parse_seeds(args.seeds)

        print(f"=== Sacred Experiment: daily_brief_monte_carlo ===")
        print(f"Date:        {args.date}")
        print(f"Engine:      {args.engine}")
        print(f"Runs:        {args.runs}")
        print(f"Seed start:  {args.seed_start}")
        print(f"DB path:     {args.db}")
        print(f"SQL observer: {args.sql_url or 'sqlite:///docs/experiments/runs.db'}")
        print("========================================================")

        monte_carlo_ex.run(
            command_name="run",
            config_updates={
                "date": args.date,
                "db_path": args.db,
                "config_path": args.config,
                "engine": args.engine,
                "n_runs": args.runs,
                "seed_start": args.seed_start,
            },
        )
        print("\nSacred run complete. See docs/experiments/runs.db for the SQL observer store.")

    elif args.command == "sweep":
        _configure_observer(sweep_ex, args.sql_url, args.unobserved)
        seeds = _parse_seeds(args.seeds)

        param_grid = {}
        for p in args.param:
            name, values_str = p.split("=")
            try:
                import json
                values = json.loads(f"[{values_str}]")
            except json.JSONDecodeError:
                values = [v.strip() for v in values_str.split(",")]
            param_grid[name] = values

        print(f"=== Sacred Experiment: daily_brief_parameter_sweep ===")
        print(f"Date:        {args.date}")
        print(f"Engine:      {args.engine}")
        print(f"Param grid:  {param_grid}")
        print(f"Metric:      {args.metric}")
        print(f"Seeds:       {seeds}")
        print(f"DB path:     {args.db}")
        print(f"SQL observer: {args.sql_url or 'sqlite:///docs/experiments/runs.db'}")
        print("========================================================")

        sweep_ex.run(
            command_name="run",
            config_updates={
                "date": args.date,
                "db_path": args.db,
                "config_path": args.config,
                "engine": args.engine,
                "seeds": seeds,
                "param_grid": param_grid,
                "metric": args.metric,
            },
        )
        print("\nSacred run complete. See docs/experiments/runs.db for the SQL observer store.")

    elif args.command == "ablation":
        _configure_observer(ablation_ex, args.sql_url, args.unobserved)
        seeds = _parse_seeds(args.seeds)
        feature_flags = {f.strip(): True for f in args.features.split(",")}

        print(f"=== Sacred Experiment: daily_brief_ablation ===")
        print(f"Date:        {args.date}")
        print(f"Engine:      {args.engine}")
        print(f"Features:    {list(feature_flags.keys())}")
        print(f"Seeds:       {seeds}")
        print(f"DB path:     {args.db}")
        print(f"SQL observer: {args.sql_url or 'sqlite:///docs/experiments/runs.db'}")
        print("========================================================")

        ablation_ex.run(
            command_name="run",
            config_updates={
                "date": args.date,
                "db_path": args.db,
                "config_path": args.config,
                "engine": args.engine,
                "seeds": seeds,
                "features": args.features,
            },
        )
        print("\nSacred run complete. See docs/experiments/runs.db for the SQL observer store.")

    elif args.command == "clustering-ablation":
        _configure_observer(clustering_ablation_ex, args.sql_url, args.unobserved)

        print(f"=== Sacred Experiment: daily_brief_clustering_ablation ===")
        print(f"Date:        {args.date}")
        print(f"Test frac:   {args.test_frac}")
        print(f"DB path:     {args.db}")
        print(f"Config:      {args.config}")
        print(f"SQL observer: {args.sql_url or 'sqlite:///docs/experiments/runs.db'}")
        print("========================================================")

        clustering_ablation_ex.run(
            command_name="run",
            config_updates={
                "date": args.date,
                "test_frac": args.test_frac,
                "db_path": args.db,
                "config_path": args.config,
            },
        )
        print("\nSacred run complete. See docs/experiments/runs.db for the SQL observer store.")


if __name__ == "__main__":
    main()
