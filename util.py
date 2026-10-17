"""Shared, tiny utilities used across the brief modules.

WARNINGS is a mutable list so every module appends to the same log.
LOG_FILE is rebound by brief.main (--log-file) and read by the fetcher when
starting the background Semantic Scholar refresh; modules must read it as
``util.LOG_FILE`` at call time rather than copying the reference.
"""
from __future__ import annotations

import sys
from pathlib import Path

WARNINGS: list[str] = []
LOG_FILE: Path | None = None


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
    if LOG_FILE:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(msg + "\n")
            f.flush()


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    log(f"warn: {msg}")
