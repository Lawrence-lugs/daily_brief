"""Sacred experiment runner for daily brief engine comparisons.

Uses the ``sacred`` package to manage experiment configuration, input
resources, and artefacts:

* All input JSON files are stored as sacred **resources** (recorded with each run).
* The SQLite database state is captured as a SHA-256 hash and recorded as
  **config** (so any change to the DB produces a new config value).
* Each run is persisted by a :class:`sacred.observers.SqlObserver` writing to
  ``docs/experiments/runs.db`` (SQLite) by default, alongside the generated
  JSON/HTML artefact files.

The experiment wraps :func:`simulate.experiments.runner.compare_engines`, so
the same keyword/LR comparison logic is used — just now tracked by sacred.

Usage (from the project root)::

    python -m simulate.cli sacred --date 2026-10-29 --seeds 1-10
    python -m simulate.cli sacred --date 2026-10-29 --engines keyword,lr --sql-url postgresql://user:pass@localhost/daily_brief
    python -m simulate.cli sacred --date 2026-10-29 --unobserved

Programmatic usage::

    from simulate.experiments.sacred_runner import ex
    ex.run(config_updates={"date": "2026-10-29", "seeds": [1, 2, 3]})
"""
from __future__ import annotations

import hashlib
import importlib.util
import pkgutil
from pathlib import Path

# ---------------------------------------------------------------------------
# Python 3.14 compatibility shim for sacred 0.8.7
#
# sacred 0.8.7 calls ``pkgutil.find_loader`` (removed in Python 3.14) and
# ``pkg_resources`` (removed in setuptools >= 81).  We already pinned
# setuptools < 81 in the environment; this shim covers ``find_loader``.
# ---------------------------------------------------------------------------
if not hasattr(pkgutil, "find_loader"):
    pkgutil.find_loader = importlib.util.find_spec  # type: ignore[attr-defined]

from sacred import Experiment
from sacred.observers import SqlObserver

from simulate.experiments.runner import compare_engines, DEFAULT_OUTPUT_DIR
from simulate.core.pool import PoolProvider
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine
from simulate.core.config import load_config, merge_config


ex = Experiment("daily_brief_engine_comparison")

# ---------------------------------------------------------------------------
# Sacred observers — SQL observer is the default
# ---------------------------------------------------------------------------
# Runs are persisted to a SQLite database at docs/experiments/runs.db by
# default.  Override the connection URL with the ``--sql-url`` CLI flag, or
# attach your own observer programmatically via
# ``ex.observers.append(SqlObserver("postgresql://..."))``.
_DEFAULT_SQL_URL = "sqlite:///" + str(
    Path(DEFAULT_OUTPUT_DIR) / "runs.db"
)
ex.observers.append(SqlObserver(_DEFAULT_SQL_URL))

# ---------------------------------------------------------------------------
# Input JSON files tracked as sacred resources
# ---------------------------------------------------------------------------
# These are snapshotted with every run so the exact inputs that produced an
# experiment result can be reconstructed later.
INPUT_RESOURCES = [
    "config.json",
    "sources.json",
    "perfect_samples.json",
    "perfect-samples-new.json",
    "state.json",
]


def _file_sha256(path: str | Path) -> str:
    """SHA-256 hex digest of a file's contents."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Sacred configuration
# ---------------------------------------------------------------------------
@ex.config
def cfg():
    """Experiment configuration.

    ``db_hash`` is computed below from ``db_path`` and recorded as config, so
    any change to the SQLite database state produces a new config value and
    sacred treats it as a distinct experiment configuration.
    """
    date = "2026-10-29"
    seeds = [1, 2, 3, 4, 5]
    db_path = "daily_brief.db"
    config_path = "config.json"
    output_dir = DEFAULT_OUTPUT_DIR
    engines = ["keyword", "lr"]
    lr_model = "both"
    no_model_eval = False
    test_frac = 0.2

    # ---- DB state as config (hash only) ----
    _db_p = Path(db_path)
    db_hash = _file_sha256(_db_p) if _db_p.exists() else ""


@ex.command
def run(
    date,
    seeds,
    db_path,
    config_path,
    output_dir,
    engines,
    lr_model,
    no_model_eval,
    test_frac,
    db_hash,
    _run,
):
    """Run the engine comparison experiment under sacred.

    Registers the input JSON files as sacred resources, runs the comparison,
    and attaches the generated JSON/HTML artefacts to the sacred run.
    """
    project_root = Path(__file__).resolve().parent.parent.parent

    # --- Register input JSON files as sacred resources ---
    for res_name in INPUT_RESOURCES:
        res_path = project_root / res_name
        if res_path.exists():
            _run.add_resource(str(res_path))

    # Surface the db hash in run info for quick visibility.
    _run.info["db_hash"] = db_hash
    _run.info["db_path"] = db_path

    # --- Load and merge configuration ---
    raw_config = load_config(config_path)
    config = merge_config(raw_config, date=date)

    # --- Build engines ---
    engine_objs = []
    if "keyword" in engines:
        engine_objs.append(KeywordEngine(config))
    if "lr" in engines:
        engine_objs.append(LREngine(project_root=str(project_root)))

    # --- Pool provider ---
    pool_provider = PoolProvider(db_path)

    # --- Run comparison ---
    results, json_path, html_path = compare_engines(
        date=date,
        seeds=seeds,
        engines=engine_objs,
        pool_provider=pool_provider,
        config=config,
        output_dir=output_dir,
        model_eval=None,
    )

    # --- Attach artefacts to the sacred run ---
    _run.add_artifact(str(json_path))
    _run.add_artifact(str(html_path))

    # Return None: the full results are attached as artefacts above.
    # (SqlObserver's result column expects a scalar, not a dict.)
    return None


# Expose the experiment for programmatic / CLI use.
__all__ = ["ex", "INPUT_RESOURCES"]
