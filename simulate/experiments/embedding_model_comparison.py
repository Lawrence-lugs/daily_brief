"""Reproducible embedding-model comparison experiment.

Runs `node ranker/cli.js eval` for each embedding model registered in
ranker/embedder.js, reads the results back from the ``model_eval`` table in
``daily_brief.db``, and writes a markdown report to ``docs/experiments/`` named
with date and time.

Usage (from project root):

    python simulate/experiments/embedding_model_comparison.py --date 2026-11-01 --test-frac 0.2

Each model run:

1. Sets ``ranker.embedding.model`` via ``--set`` so the Node CLI picks the model.
2. Runs ``node ranker/cli.js eval --date D --test-frac F --set embedding.model=X``.
   The CLI embeds the pool (purging any previous model's rows), fits the LR
   model, evaluates chronological holdout, and appends a row to ``model_eval``.
3. The script then reads the latest row per model from ``model_eval`` and
   generates a markdown report.

Because embeddings are purged when the model changes, each model run re-embeds
the full pool (~3.4k items). Running the same model twice returns cached
results (the CLI's refit cache hits and ``model_eval`` already has a row).

Note: this experiment is *not fully reproducible* across runs because the test
set is small (n ≈ 50 with test_frac=0.2) and embedding vectors carry small
quantization noise. It *is* reproducible in the sense that the same model run
twice on the same DB yields the same AUC/logLoss.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]  # simulate/experiments -> project root
DB_PATH = PROJECT_ROOT / "daily_brief.db"
CLI_PATH = PROJECT_ROOT / "ranker" / "cli.js"
REPORT_DIR = PROJECT_ROOT / "docs" / "experiments"

# Registry keys from ranker/embedder.js MODELS.
EMBEDDING_MODELS = [
    "bge-micro",
    "leaf-mt",
    "bge-small",
    "bge-base",
    "mpnet",
]


def run_eval(model: str, date: str, test_frac: float) -> dict[str, Any]:
    """Run `node ranker/cli.js eval` for one embedding model.

    Returns the parsed stdout JSON (prior / keyword / fitted AUC & logLoss).
    Raises RuntimeError on failure.
    """
    cmd = [
        "node",
        str(CLI_PATH),
        "eval",
        "--date",
        date,
        "--testFrac",
        str(test_frac),
        "--set",
        f"embedding.model={model}",
    ]
    print(f"  Running eval for model={model} ...")
    result = subprocess.run(
        cmd,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )
    if result.returncode != 0:
        stderr = result.stderr or ""
        raise RuntimeError(f"eval for {model} failed (exit {result.returncode}): {stderr[-2000:]}")

    # The CLI prints logs to stderr and JSON to stdout. Find the JSON object.
    stdout = result.stdout.strip()
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        # Try to find the first line starting with '{'
        for line in stdout.splitlines():
            if line.strip().startswith("{"):
                return json.loads(line.strip())
        raise RuntimeError(f"Could not parse eval output for {model}: {stdout[:500]}")


def read_latest_evals(date: str | None = None) -> list[dict[str, Any]]:
    """Read the latest model_eval row per embedding_tag from the DB."""
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Database not found: {DB_PATH}")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT embedding_tag, cutoff_date, test_frac, n_train, n_test,
                   prior_auc, prior_logloss, keyword_auc, keyword_logloss,
                   fitted_auc, fitted_logloss, results, created_at
            FROM model_eval
            WHERE cutoff_date = ?
            ORDER BY created_at ASC
            """,
            (date,),
        ).fetchall()
    finally:
        conn.close()

    # Keep the latest row per embedding_tag.
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        tag = row["embedding_tag"]
        latest[tag] = dict(row)
    return [latest[tag] for tag in sorted(latest)]


def filter_by_model(rows: list[dict[str, Any]], models: list[str]) -> list[dict[str, Any]]:
    """Keep only rows whose embedding tag matches one of the given models."""
    model_prefixes = {m + ":" for m in models}
    return [r for r in rows if any(r["embedding_tag"].startswith(p) for p in model_prefixes)]


def generate_markdown(rows: list[dict[str, Any]], date: str, test_frac: float) -> str:
    """Generate a markdown report from the eval rows."""
    lines: list[str] = []
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    lines.append(f"# Embedding Model Comparison — LR Evaluation")
    lines.append("")
    lines.append(f"- **Date:** {date}")
    lines.append(f"- **Test fraction:** {test_frac}")
    lines.append(f"- **Generated:** {datetime.now().isoformat()}")
    lines.append(f"- **Database:** {DB_PATH}")
    lines.append("")
    lines.append("## Results")
    lines.append("")
    lines.append(
        "| Embedding model | Tag | n_train | n_test | Prior AUC | Prior logLoss | Keyword AUC | Keyword logLoss | Fitted AUC | Fitted logLoss |"
    )
    lines.append(
        "|-----------------|-----|---------|--------|-----------|---------------|-------------|-----------------|------------|----------------|"
    )

    def fmt(x: Any) -> str:
        return f"{x:.4f}" if x is not None else "N/A"

    for r in rows:
        tag = r["embedding_tag"]
        model = tag.split(":")[0]
        lines.append(
            f"| {model} | {tag} | {r['n_train']} | {r['n_test']} | "
            f"{fmt(r['prior_auc'])} | {fmt(r['prior_logloss'])} | "
            f"{fmt(r['keyword_auc'])} | {fmt(r['keyword_logloss'])} | "
            f"{fmt(r['fitted_auc'])} | {fmt(r['fitted_logloss'])} |"
        )
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append("- Each model run re-embeds the full pool (embeddings are purged on model switch).")
    lines.append("- The `fitted` column is the Bayesian LR model trained on the training split.")
    lines.append("- The `keyword` column uses the `rel` score from `candidate_pool` as the baseline.")
    lines.append("- Test set is small (n ≈ 50 with test_frac=0.2), so AUC differences may not be significant.")
    lines.append("")
    lines.append("## Full results (JSON)")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(rows, indent=2))
    lines.append("```")
    lines.append("")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reproducible embedding-model comparison experiment."
    )
    parser.add_argument("--date", required=True, help="Evaluation date YYYY-MM-DD")
    parser.add_argument(
        "--testFrac", type=float, default=0.2, help="Test fraction for chronological holdout"
    )
    parser.add_argument(
        "--models",
        nargs="*",
        default=EMBEDDING_MODELS,
        help="Embedding model keys to evaluate (default: all five)",
    )
    parser.add_argument(
        "--skip-eval",
        action="store_true",
        help="Skip running eval; just read existing model_eval rows and write the report",
    )
    args = parser.parse_args()

    models = args.models or EMBEDDING_MODELS

    # Validate models
    valid = set(EMBEDDING_MODELS)
    invalid = [m for m in models if m not in valid]
    if invalid:
        print(f"Error: unknown model(s): {invalid}. Valid: {sorted(valid)}")
        return 1

    if not CLI_PATH.exists():
        print(f"Error: CLI not found: {CLI_PATH}")
        return 1

    if args.skip_eval:
        print("Skipping eval runs; reading existing model_eval rows...")
    else:
        errors = []
        for model in models:
            try:
                run_eval(model, args.date, args.testFrac)
            except Exception as e:
                print(f"ERROR evaluating {model}: {e}")
                errors.append(model)
        if errors:
            print(f"WARNING: {len(errors)} model(s) failed: {', '.join(errors)}")
            if len(errors) == len(models):
                return 1

    # Read results from DB
    all_rows = read_latest_evals(args.date)
    rows = filter_by_model(all_rows, models)

    if not rows:
        print("No model_eval rows found for the requested models.")
        return 1

    # Generate report
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_name = f"embedding_model_comparison_{args.date}_{ts}.md"
    report_path = REPORT_DIR / report_name
    md = generate_markdown(rows, args.date, args.testFrac)
    report_path.write_text(md, encoding="utf-8")
    print(f"\nReport written to {report_path}")

    # Also write raw JSON
    json_name = f"embedding_model_comparison_{args.date}_{ts}.json"
    json_path = REPORT_DIR / json_name
    json_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print(f"Raw results written to {json_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
