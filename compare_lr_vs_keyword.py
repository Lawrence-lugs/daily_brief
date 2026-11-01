#!/usr/bin/env python3
"""
Compare the current LR setup to the keyword setup.

Loads the shared candidate pool from the SQLite database, runs both the
KeywordEngine (legacy) and LREngine (new, Node.js-backed) across multiple
seeds, and prints comparison metrics per desk (overlap/Jaccard, freshness,
source types, selection modes) plus aggregate stability stats and model
accuracy estimates against the liked training/test set.

Results (JSON + HTML) are written to docs/experiments/ by default.

Usage (run from the project root):
    python compare_lr_vs_keyword.py
    python compare_lr_vs_keyword.py --date 2026-10-29 --seeds 1-10
    python compare_lr_vs_keyword.py --no-model-eval
    python compare_lr_vs_keyword.py --test-frac 0.3
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
from pathlib import Path

# Ensure the project root (parent of the simulate package) is importable.
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from simulate import (  # noqa: E402  (import after sys.path tweak)
    DEFAULT_OUTPUT_DIR,
    KeywordEngine,
    LREngine,
    PoolProvider,
    compare_engines,
    freshness_config_summary,
    load_config,
    merge_config,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare the LR engine vs the keyword engine."
    )
    parser.add_argument("--date", default="2026-10-29", help="Date (YYYY-MM-DD)")
    parser.add_argument("--db", default="daily_brief.db", help="Database path")
    parser.add_argument("--config", default="config.json", help="Config file path")
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Output directory for results",
    )
    parser.add_argument(
        "--seeds",
        default="1-10",
        help="Seed range (e.g., 1-10 or 1,2,3)",
    )
    parser.add_argument(
        "--no-model-eval",
        action="store_true",
        help="Skip model evaluation against liked training/test set",
    )
    parser.add_argument(
        "--test-frac",
        type=float,
        default=0.2,
        help="Test fraction for chronological holdout evaluation (default: 0.2)",
    )
    return parser.parse_args()


def parse_seeds(seeds_str: str) -> list[int]:
    if "-" in seeds_str and "," not in seeds_str:
        start, end = map(int, seeds_str.split("-"))
        return list(range(start, end + 1))
    return [int(s) for s in seeds_str.split(",")]


def run_model_eval(project_root: Path, date: str, test_frac: float = 0.2) -> dict | None:
    """Run the LR model evaluation against liked training/test set.
    
    Calls `node ranker/cli.js eval` which computes AUC and logLoss for:
    - Prior-only model
    - Keyword rel baseline
    - Fitted LR model
    
    Uses chronological holdout (test_frac of most recent dates).
    """
    cli_path = project_root / "ranker" / "cli.js"
    if not cli_path.exists():
        print(f"  Warning: LR CLI not found at {cli_path}, skipping model evaluation")
        return None
    
    try:
        cmd = ["node", str(cli_path), "eval", "--date", date]
        if test_frac:
            cmd.extend(["--testFrac", str(test_frac)])
        
        print(f"  Running model evaluation (test_frac={test_frac})...")
        result = subprocess.run(
            cmd,
            cwd=project_root,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=180,
        )
        
        if result.returncode != 0:
            print(f"  Warning: Model evaluation failed: {result.stderr[:200]}")
            return None
        
        # Parse JSON output (may have log lines on stderr)
        try:
            # Find the first line that starts with {
            lines = result.stdout.strip().split('\n')
            json_start = next(i for i, line in enumerate(lines) if line.strip().startswith('{'))
            json_str = '\n'.join(lines[json_start:])
            eval_results = json.loads(json_str)
            print(f"  Model evaluation complete")
            return eval_results
        except (json.JSONDecodeError, StopIteration) as e:
            print(f"  Warning: Failed to parse eval output: {result.stdout[:200]}")
            return None
            
    except subprocess.TimeoutExpired:
        print(f"  Warning: Model evaluation timed out")
        return None
    except Exception as e:
        print(f"  Warning: Model evaluation error: {e}")
        return None


def main() -> None:
    args = parse_args()
    seeds = parse_seeds(args.seeds)

    # --- Configuration ---------------------------------------------------
    raw_config = load_config(args.config)
    config = merge_config(raw_config, date=args.date)

    print("=== Freshness Configuration ===")
    fs = freshness_config_summary(config)
    lr = fs["lr_freshness"]
    print(
        f"LR model: {lr['model']} | halfLifeDays={lr['halfLifeDays']} | "
        f"steepness={lr['steepness']:.4f} | epsilon={lr['epsilon']}"
    )
    kw = fs["keyword_freshness"]
    print(
        f"Keyword model: {kw['model']} | a50_days={kw['a50_days']} | "
        f"slope={kw['slope']} | epsilon={kw['epsilon']}"
    )
    print("===============================\n")

    # --- Engines ---------------------------------------------------------
    engines = [
        KeywordEngine(config),
        LREngine(project_root=PROJECT_ROOT),
    ]
    print(f"Engines: {[e.name for e in engines]}")
    print(f"Seeds:   {seeds}\n")

    # --- Model evaluation (accuracy against liked training/test set) ------
    eval_results = None
    if not args.no_model_eval:
        print("--- Model Evaluation (Liked Training/Test Set) ---")
        eval_results = run_model_eval(PROJECT_ROOT, args.date, test_frac=args.test_frac)

        # Print model evaluation results
        if eval_results:
            print(f"--- Model Accuracy (Chronological Holdout, test_frac={args.test_frac}) ---")
            for model_name in ["prior", "keyword", "fitted"]:
                res = eval_results.get(model_name, {})
                auc = res.get("auc")
                ll = res.get("logLoss")
                if auc is not None and not (isinstance(auc, float) and auc != auc):  # not NaN
                    print(f"  {model_name:10s}: AUC = {auc:.4f}  logLoss = {ll:.4f}")
                else:
                    print(f"  {model_name:10s}: N/A (insufficient training data)")
            print()

    # --- Run comparison --------------------------------------------------
    try:
        results = compare_engines(
            date=args.date,
            seeds=seeds,
            engines=engines,
            pool_provider=PoolProvider(args.db),
            config=config,
            output_dir=args.output,
            model_eval=eval_results,
        )
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}")
        print("Make sure daily_brief.db and config.json exist at the project root.")
        sys.exit(1)
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        print("The LR engine shells out to `node ranker/cli.js`; ensure Node.js is installed.")
        sys.exit(1)

    # --- Summary ---------------------------------------------------------
    print("\n" + "=" * 60)
    print("COMPARISON SUMMARY")
    print("=" * 60)
    print(f"Date:      {results['date']}")
    print(f"Engines:   {results['engines']}")
    print(f"Pool size: {results['pool_size']}")
    print(f"Seeds:     {results['seeds']}")
    print(f"Output:    {args.output}\n")

    for desk in ["primary", "science"]:
        agg = results["aggregate"].get(desk, {})
        print(f"--- {desk.upper()} desk ---")
        for engine_name in results["engines"]:
            stats = agg.get(engine_name, {})
            print(f"  [{engine_name}]")
            print(f"    ever_picked:        {stats.get('ever_picked', 0)}")
            print(
                f"    consec_jaccard mean:{stats.get('consecutive_jaccard_mean', 0):.3f}  "
                f"median:{stats.get('consecutive_jaccard_median', 0):.3f}"
            )
            top = stats.get("top_items", [])[:5]
            if top:
                print(f"    top items:          {top}")
        print()

    print("Per-desk overlap (keyword vs lr), averaged across seeds:")
    for desk in ["primary", "science"]:
        jaccards = []
        for run in results.get("runs", []):
            comp = run.get("comparison", {}).get(desk)
            if comp and "overlap" in comp:
                jaccards.append(comp["overlap"]["jaccard"])
        if jaccards:
            print(
                f"  {desk}: mean Jaccard = {statistics.mean(jaccards):.3f}  "
                f"(n={len(jaccards)})"
            )
        else:
            print(f"  {desk}: no comparison data")

    json_name = f"comparison_{args.date}_{len(seeds)}seeds.json"
    html_name = f"comparison_{args.date}_{len(seeds)}seeds.html"
    print(f"\nJSON results: {args.output}/{json_name}")
    print(f"HTML report:  {args.output}/{html_name}")
    print("\nDone.")


if __name__ == "__main__":
    main()
