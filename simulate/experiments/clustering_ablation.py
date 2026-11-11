"""Sacred experiment: clustering ablation — liked items vs perfect samples only.

Runs ``node ranker/eval_clustering_ablation.js`` which performs a chronological
holdout evaluation twice, identical except for which inputs seed the Ward cluster
medoids (ranker/interests.js ``buildInterests``):

* ``liked=true``   — perfect samples (weight kappa) + liked items (weight 1)
                     [current behaviour]
* ``liked=false``  — perfect samples only                                      [ablation]

Both conditions share the same training rows / labels; only the medoids (and hence the
``n:d1`` distance-to-medoid feature) differ.  The experiment records prior / keyword /
fitted AUC and logLoss for each condition, plus the delta.

Input JSONs are registered as sacred resources and ``db_hash`` is recorded as config, so
any change to the SQLite database state produces a distinct sacred configuration.

Usage (from project root)::

    python -m simulate.cli clustering-ablation --date 2026-11-01 --test-frac 0.2
    python -m simulate.cli clustering-ablation --date 2026-11-01 --unobserved

Programmatic usage::

    from simulate.experiments.clustering_ablation import ex
    ex.run(config_updates={"date": "2026-11-01", "test_frac": 0.2})
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import pkgutil
import subprocess
from pathlib import Path

if not hasattr(pkgutil, "find_loader"):
    pkgutil.find_loader = importlib.util.find_spec  # type: ignore[attr-defined]

from sacred import Experiment
from sacred.observers import SqlObserver

from simulate.core.config import load_config, merge_config
from simulate.experiments.runner import DEFAULT_OUTPUT_DIR


ex = Experiment("daily_brief_clustering_ablation")

_DEFAULT_SQL_URL = "sqlite:///" + str(Path(DEFAULT_OUTPUT_DIR) / "runs.db")
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
    test_frac = 0.2
    db_path = "daily_brief.db"
    config_path = "user/defaults/config.json"

    _db_p = Path(db_path)
    db_hash = _file_sha256(_db_p) if _db_p.exists() else ""


@ex.command
def run(date, test_frac, db_path, config_path, db_hash, _run):
    """Run the clustering ablation under sacred.

    Invokes the Node.js helper twice (liked-in-clustering vs perfect-only), collects the
    prior/keyword/fitted AUC & logLoss for each condition, and attaches the raw JSON as
    an artefact.
    """
    project_root = Path(__file__).resolve().parent.parent.parent

    # --- Register input JSON files as sacred resources ---
    for res_name in INPUT_RESOURCES:
        res_path = project_root / res_name
        if res_path.exists():
            _run.add_resource(str(res_path))

    _run.info["db_hash"] = db_hash
    _run.info["db_path"] = db_path
    _run.info["date"] = date
    _run.info["test_frac"] = test_frac

    cli_path = project_root / "simulate" / "experiments" / "eval_clustering_ablation.js"
    if not cli_path.exists():
        raise FileNotFoundError(f"CLI helper not found: {cli_path}")

    # raw config is loaded mainly to confirm config.json parses / is tracked as a resource.
    load_config(config_path)
    merge_config(load_config(config_path), date=date)

    cmd = [
        "node",
        str(cli_path),
        "--date",
        str(date),
        "--testFrac",
        str(test_frac),
    ]

    print(f"Running clustering ablation: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        cwd=str(project_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )

    if result.returncode != 0:
        stderr = result.stderr or ""
        raise RuntimeError(f"Clustering ablation failed (exit {result.returncode}): {stderr[-2000:]}")

    stdout = result.stdout.strip()
    try:
        ablation = json.loads(stdout)
    except json.JSONDecodeError:
        for line in stdout.splitlines():
            if line.strip().startswith("{"):
                ablation = json.loads(line.strip())
                break
        else:
            raise RuntimeError(f"Could not parse ablation output: {stdout[:500]}")

    # Flatten key metrics into run info for quick SQL-observer visibility.
    liked = ablation.get("liked", {})
    perfect = ablation.get("perfect", {})
    delta = ablation.get("delta", {})

    _run.info["n_train"] = ablation.get("nTrain")
    _run.info["n_test"] = ablation.get("nTest")
    _run.info["cutoff_date"] = ablation.get("cutoff_date")

    # liked condition
    _run.info["liked_clusters"] = liked.get("clusters")
    _run.info["liked_fitted_auc"] = liked.get("fitted", {}).get("auc")
    _run.info["liked_fitted_logloss"] = liked.get("fitted", {}).get("logLoss")
    _run.info["liked_prior_auc"] = liked.get("prior", {}).get("auc")
    _run.info["liked_keyword_auc"] = liked.get("keyword", {}).get("auc")

    # perfect condition
    _run.info["perfect_clusters"] = perfect.get("clusters")
    _run.info["perfect_fitted_auc"] = perfect.get("fitted", {}).get("auc")
    _run.info["perfect_fitted_logloss"] = perfect.get("fitted", {}).get("logLoss")
    _run.info["perfect_prior_auc"] = perfect.get("prior", {}).get("auc")
    _run.info["perfect_keyword_auc"] = perfect.get("keyword", {}).get("auc")

    # delta
    _run.info["delta_fitted_auc"] = delta.get("fitted_auc")
    _run.info["delta_fitted_logloss"] = delta.get("fitted_logloss")
    _run.info["delta_prior_auc"] = delta.get("prior_auc")
    _run.info["delta_prior_logloss"] = delta.get("prior_logloss")

    # Attach the full JSON artefact.
    import tempfile

    artifact_path = Path(tempfile.gettempdir()) / f"clustering_ablation_{date}_{test_frac}.json"
    artifact_path.write_text(json.dumps(ablation, indent=2), encoding="utf-8")
    _run.add_artifact(str(artifact_path))

    print("Clustering ablation complete.")
    print(f"  liked     : fitted AUC={liked.get('fitted', {}).get('auc'):.4f} "
          f"logLoss={liked.get('fitted', {}).get('logLoss'):.4f}")
    print(f"  perfect   : fitted AUC={perfect.get('fitted', {}).get('auc'):.4f} "
          f"logLoss={perfect.get('fitted', {}).get('logLoss'):.4f}")
    print(f"  delta     : fitted AUC={delta.get('fitted_auc'):+.4f} "
          f"logLoss={delta.get('fitted_logloss'):+.4f}")

    # Return None: the full results are attached as artefacts above.
    # (SqlObserver's result column expects a scalar, not a dict.)
    return None


__all__ = ["ex", "INPUT_RESOURCES"]
