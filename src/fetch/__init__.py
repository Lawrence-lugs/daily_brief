"""Fetching subsystem package.

Imports every source module under this package so each module's module-level
``register_api_fetcher(...)`` call fires at import time.  As a result, adding
a new ``"api"`` source requires only: a new module here (which registers its
fetcher) and a spec in ``sources.json`` — no edits to ``brief.py`` or any
other existing module are needed.

``fetcher.py`` is deliberately skipped here because it is imported directly by
``brief.py`` and must not re-trigger package initialization.
"""
from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

_PKG_DIR = Path(__file__).resolve().parent

for _mod in pkgutil.iter_modules([str(_PKG_DIR)]):
    if _mod.name == "fetcher":
        continue
    importlib.import_module(f"fetch.{_mod.name}")
