"""Progress file for the live generation UI (stdlib only, never raises).

brief.py passes `--progress-file <path>`; the node JobRunner tails it and the client renders it.
The file is rewritten atomically (tmp + os.replace) after every state change, so a reader never
sees a half-written document. Contract (v1):

    {"v":1, "seq":int, "phase":"fetching|selecting|editing|committing|done", "engine":"lr|keyword|null",
     "t0":unix_seconds,
     "desks":{name:{"title":str, "n":int, "stage":"pending|raw|edited", "working":bool,
                    "deck":str, "items":[slim item,...]}}}

stage "raw"    = LR only: the winners are already decided; items carry raw title/snippet.
stage "edited" = the editor finished this desk; items carry headline/blurb/why_care/tags.
"""
from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

ITEM_FIELDS = (
    "id", "title", "url", "source", "source_type", "subtopic", "kind", "mode", "age_days",
    "p", "V", "cluster", "core", "cos_dist", "cluster_size", "cluster_pool", "medoid_id",
    "headline", "blurb", "why_care", "tags", "significance", "summarized",
)


def _clean(v):
    """JSON-safe copy: NaN/inf -> None (JSON.parse in node rejects NaN), unknown types -> str."""
    if isinstance(v, bool) or v is None or isinstance(v, (str, int)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, (list, tuple, set)):
        return [_clean(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    return str(v)


def slim_item(it: dict) -> dict:
    out = {k: _clean(it[k]) for k in ITEM_FIELDS if k in it}
    out["snippet"] = str(it.get("snippet") or "")[:320]
    return out


class Progress:
    def __init__(self, path: Path | str | None = None, engine: str | None = None):
        self.path = Path(path) if path else None
        self.data = {"v": 1, "seq": 0, "phase": "fetching", "engine": engine,
                     "t0": time.time(), "desks": {}}
        self._flush()

    def _flush(self) -> None:
        if self.path is None:
            return
        self.data["seq"] += 1
        try:
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            for attempt in range(6):          # Windows: replace can lose a race with a reader
                try:
                    os.replace(tmp, self.path)
                    return
                except PermissionError:
                    time.sleep(0.05 * (attempt + 1))
        except Exception:
            pass                               # progress must never break a generation

    # -- state changes -------------------------------------------------------------------------
    def set_engine(self, engine: str) -> None:
        self.data["engine"] = engine
        self._flush()

    def phase(self, name: str) -> None:
        self.data["phase"] = name
        self._flush()

    def desk_init(self, desk: str, title: str, n: int) -> None:
        self.data["desks"][desk] = {"title": title, "n": int(n), "stage": "pending",
                                    "working": False, "deck": "", "items": []}
        self._flush()

    def desk_raw(self, desk: str, items: list[dict]) -> None:
        d = self.data["desks"].setdefault(desk, {"title": desk, "n": len(items), "deck": ""})
        d.update(stage="raw", working=False, items=[slim_item(i) for i in items])
        self._flush()

    def desk_working(self, desk: str, flag: bool = True) -> None:
        if desk in self.data["desks"]:
            self.data["desks"][desk]["working"] = bool(flag)
            self._flush()

    def desk_edited(self, desk: str, stories: list[dict], deck: str = "") -> None:
        d = self.data["desks"].setdefault(desk, {"title": desk, "n": len(stories)})
        d.update(stage="edited", working=False, deck=str(deck or ""),
                 items=[slim_item(s) for s in stories])
        self._flush()
