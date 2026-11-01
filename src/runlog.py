"""Run log shared with the Node ranker: one JSONL file per run under logs/ranker/.

Level comes from RANKER_DEBUG with the same rules as ranker/debuglog.js: unset/''/0/false => summary,
1/true => detail, summary|detail|trace by name. Summary events are always written.
The child Node process joins this file through RANKER_RUN_ID (see RunLog.child_env).
"""
from __future__ import annotations

import atexit
import datetime as dt
import json
import os
import platform
import secrets
from pathlib import Path

LEVELS = {"summary": 1, "detail": 2, "trace": 3}
_ALIASES = {"": "summary", "0": "summary", "false": "summary", "1": "detail", "true": "detail"}


def resolve_level(raw: str | None = None) -> str:
    if raw is None:
        raw = os.environ.get("RANKER_DEBUG", "")
    v = raw.strip().lower()
    if v in _ALIASES:
        return _ALIASES[v]
    if v in LEVELS:
        return v
    raise ValueError(f"RANKER_DEBUG must be summary|detail|trace (got {raw!r})")


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


class RunLog:
    def __init__(self, root: Path, cmd: str, **header):
        self.level = resolve_level()
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.run_id = os.environ.get("RANKER_RUN_ID") or f"{stamp}-{cmd}-{secrets.token_hex(3)}"
        log_dir = Path(root) / "logs" / "ranker"
        log_dir.mkdir(parents=True, exist_ok=True)
        self.path = log_dir / f"{self.run_id}.jsonl"
        self._f = self.path.open("a", encoding="utf-8")
        self._seq = 0
        self._closed = False
        self.event("header", {
            "cmd": cmd, **header, "level": self.level, "python": platform.python_version(),
            "pid": os.getpid(), "started": _now_iso(),
        })
        atexit.register(self.close)

    def want(self, level: str = "summary") -> bool:
        return LEVELS[level] <= LEVELS[self.level]

    def event(self, kind: str, data: dict | None = None, level: str = "summary") -> None:
        if self._closed or not self.want(level):
            return
        rec = {"src": "py", "seq": self._seq, "level": level, "kind": kind, "data": data or {}}
        self._seq += 1
        self._f.write(json.dumps(rec, ensure_ascii=True, default=str) + "\n")
        self._f.flush()

    def child_env(self) -> dict:
        return {**os.environ, "RANKER_RUN_ID": self.run_id}

    def close(self) -> None:
        if self._closed:
            return
        self.event("end", {"t": _now_iso()})
        self._closed = True
        self._f.close()
