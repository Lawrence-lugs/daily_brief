#!/usr/bin/env python3
"""
Compare the current LR setup to the keyword setup.

Loads the shared candidate pool from the SQLite database, runs both the
KeywordEngine (legacy) and LREngine (new, Node.js-backed) across multiple
seeds, and prints comparison metrics per desk (overlap/Jaccard, freshness,
source types, selection modes) plus aggregate stability stats and model
accuracy estimates against the liked training/test set.

The LR engine can run either the Bayesian model (``bayes_lr``, the default)
or the non-Bayesian L2-penalised logistic regression (registered as ``lr`` in
``ranker/model.js``). Use ``--lr-model`` to select which variant(s) to include.

Results (JSON + HTML) are written to docs/experiments/ by default.

Usage (run from the project root):
    python compare_lr_vs_keyword.py                    # uses today's date, both LR variants
    python compare_lr_vs_keyword.py --date 2026-10-29 --seeds 1-10
    python compare_lr_vs_keyword.py --lr-model nonbayes --no-model-eval
    python compare_lr_vs_keyword.py --lr-model bayes --test-frac 0.3
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import webbrowser
from datetime import datetime
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
    parser.add_argument("--date", default=None, help="Date (YYYY-MM-DD), defaults to today")
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
        "--lr-model",
        default="both",
        choices=["bayes", "nonbayes", "both"],
        help="Which LR model variant(s) to include: 'bayes' (SparseBayesLogReg, default), "
        "'nonbayes' (SparseLogReg, L2-penalised MLE), or 'both' (default: both)",
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


def run_model_eval(
    project_root: Path, date: str, test_frac: float = 0.2, model_name: str | None = None
) -> dict | None:
    """Run the LR model evaluation against liked training/test set.

    Calls `node ranker/cli.js eval` which computes AUC and logLoss for:
    - Prior-only model
    - Keyword rel baseline
    - Fitted LR model

    Uses chronological holdout (test_frac of most recent dates).

    Args:
        project_root: Path to the project root.
        date: Date string (YYYY-MM-DD) used as cutoff.
        test_frac: Test fraction for chronological holdout.
        model_name: Optional LR model variant name ('bayes_lr' or 'lr'). When set,
            passed via ``--set model.name=<name>`` so the non-Bayesian variant can be
            evaluated alongside the default Bayesian one. When None, uses the config
            default (bayes_lr).

    Returns:
        Dict keyed by model name ("prior", "keyword", "fitted"), or None on failure.
    """
    cli_path = project_root / "ranker" / "cli.js"
    if not cli_path.exists():
        print(f"  Warning: LR CLI not found at {cli_path}, skipping model evaluation")
        return None

    try:
        cmd = ["node", str(cli_path), "eval", "--date", date]
        if model_name is not None:
            cmd.extend(["--set", f"model.name={model_name}"])
        if test_frac:
            cmd.extend(["--testFrac", str(test_frac)])

        label = model_name or "bayes_lr (default)"
        print(f"  Running model evaluation (model={label}, test_frac={test_frac})...")
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
            print(f"  Warning: Model evaluation failed ({label}): {result.stderr[:200]}")
            return None

        # Parse JSON output (may have log lines on stderr)
        try:
            # Find the first line that starts with {
            lines = result.stdout.strip().split('\n')
            json_start = next(i for i, line in enumerate(lines) if line.strip().startswith('{'))
            json_str = '\n'.join(lines[json_start:])
            eval_results = json.loads(json_str)
            print(f"  Model evaluation complete ({label})")
            return eval_results
        except (json.JSONDecodeError, StopIteration) as e:
            print(f"  Warning: Failed to parse eval output ({label}): {result.stdout[:200]}")
            return None

    except subprocess.TimeoutExpired:
        print(f"  Warning: Model evaluation timed out ({label})")
        return None
    except Exception as e:
        print(f"  Warning: Model evaluation error ({label}): {e}")
        return None


def main() -> None:
    args = parse_args()
    if args.date is None:
        args.date = datetime.now().strftime("%Y-%m-%d")
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
    engines = [KeywordEngine(config)]
    if args.lr_model in ("bayes", "both"):
        engines.append(LREngine(project_root=PROJECT_ROOT))  # bayes_lr, engine name "lr"
    if args.lr_model in ("nonbayes", "both"):
        engines.append(
            LREngine(
                project_root=PROJECT_ROOT,
                model_name="lr",
                name="lr_nonbayes",
            )
        )  # non-bayesian SparseLogReg (L2-penalised MLE)
    print(f"Engines: {[e.name for e in engines]}")
    print(f"Seeds:   {seeds}\n")

    # --- Model evaluation (accuracy against liked training/test set) ------
    eval_results: dict | None = None
    if not args.no_model_eval:
        print("--- Model Evaluation (Liked Training/Test Set) ---")

        # Which LR model variants to evaluate. Default (bayes_lr) is always
        # evaluated; the non-bayesian variant ('lr') is added when requested.
        lr_variants: list[tuple[str, str | None]] = [("bayes_lr (default)", None)]
        if args.lr_model in ("nonbayes", "both"):
            lr_variants.append(("lr (non-bayes)", "lr"))

        # Evaluate each variant and collect results.
        variant_results: dict[str, dict] = {}
        for label, model_name in lr_variants:
            res = run_model_eval(
                PROJECT_ROOT, args.date, test_frac=args.test_frac, model_name=model_name
            )
            if res is not None:
                variant_results[label] = res

        # Print model evaluation results for every variant evaluated.
        if variant_results:
            print(f"--- Model Accuracy (Chronological Holdout, test_frac={args.test_frac}) ---")
            for label, res in variant_results.items():
                for model_name in ["prior", "keyword", "fitted"]:
                    m = res.get(model_name, {})
                    auc = m.get("auc")
                    ll = m.get("logLoss")
                    if auc is not None and not (isinstance(auc, float) and auc != auc):  # not NaN
                        print(f"  [{label}] {model_name:10s}: AUC = {auc:.4f}  logLoss = {ll:.4f}")
                    else:
                        print(f"  [{label}] {model_name:10s}: N/A (insufficient training data)")
            print()

        # Pass the nested variants dict to compare_engines / the HTML report
        # template so every evaluated LR variant appears in the model accuracy
        # card. The template macro handles both a flat dict (single variant,
        # backward compat) and a nested {label: {prior, keyword, fitted}} dict.
        if variant_results:
            eval_results = variant_results

    # --- Run comparison --------------------------------------------------
    try:
        results, json_path, html_path = compare_engines(
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

    print("\nPer-desk overlap (mean Jaccard across seeds), by engine pair:")
    engine_names = results["engines"]
    for desk in ["primary", "science"]:
        for i in range(len(engine_names)):
            for j in range(i + 1, len(engine_names)):
                a, b = engine_names[i], engine_names[j]
                jaccards = []
                for run in results.get("runs", []):
                    sel = run.get("selections", {})
                    ids_a = {it["id"] for it in sel.get(a, {}).get(desk, [])}
                    ids_b = {it["id"] for it in sel.get(b, {}).get(desk, [])}
                    if ids_a and ids_b:
                        jaccards.append(len(ids_a & ids_b) / len(ids_a | ids_b))
                if jaccards:
                    print(
                        f"  {desk}: {a} vs {b}: mean Jaccard = {statistics.mean(jaccards):.3f}  "
                        f"(n={len(jaccards)})"
                    )
                else:
                    print(f"  {desk}: {a} vs {b}: no comparison data")

    print(f"\nJSON results: {json_path}")
    print(f"HTML report:  {html_path}")

    # Auto-open the HTML report in the default browser.
    try:
        webbrowser.open(html_path.resolve().as_uri())
    except Exception as exc:
        print(f"  (Could not auto-open report: {exc})")

    print("\nDone.")


if __name__ == "__main__":
    main()
