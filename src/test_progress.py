"""Tests for src/progress.py — the live-generation progress file contract."""
from __future__ import annotations

import json
import math
import os
import tempfile
from pathlib import Path

from progress import Progress, ITEM_FIELDS, slim_item, _clean


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_init_writes_v1_with_seq_1():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "progress.json"
        prog = Progress(p)
        assert _read(p) == {
            "v": 1, "seq": 1, "phase": "fetching", "engine": None,
            "t0": prog.data["t0"], "desks": {},
        }


def test_every_state_change_increments_seq():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "progress.json"
        prog = Progress(p)
        seqs = [_read(p)["seq"]]
        prog.phase("selecting"); seqs.append(_read(p)["seq"])
        prog.desk_init("primary", "Primary desk", 5); seqs.append(_read(p)["seq"])
        prog.desk_raw("primary", [{"id": 1, "title": "T", "snippet": "S"}]); seqs.append(_read(p)["seq"])
        prog.desk_working("primary", True); seqs.append(_read(p)["seq"])
        prog.desk_edited("primary", [{"id": 1, "headline": "H", "blurb": "B"}], "deck"); seqs.append(_read(p)["seq"])
        prog.set_engine("lr"); seqs.append(_read(p)["seq"])
        prog.phase("done"); seqs.append(_read(p)["seq"])
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), seqs


def test_desk_stages_progress_pending_raw_edited():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "progress.json"
        prog = Progress(p, engine="lr")
        prog.desk_init("primary", "Primary desk", 5)
        assert _read(p)["desks"]["primary"]["stage"] == "pending"
        prog.desk_raw("primary", [{"id": 1, "title": "T", "snippet": "S", "kind": "fresh"}])
        d1 = _read(p)["desks"]["primary"]
        assert d1["stage"] == "raw"
        assert d1["items"][0]["title"] == "T"   # raw: headline falls back to title client-side
        assert d1["items"][0]["snippet"] == "S"
        assert d1["items"][0]["kind"] == "fresh"
        assert d1["working"] is False
        prog.desk_working("primary", True)
        assert _read(p)["desks"]["primary"]["working"] is True
        prog.desk_edited("primary", [{"id": 1, "headline": "H", "blurb": "B", "summarized": True}], "deck")
        d2 = _read(p)["desks"]["primary"]
        assert d2["stage"] == "edited"
        assert d2["deck"] == "deck"
        assert d2["items"][0]["headline"] == "H"
        assert d2["items"][0]["summarized"] is True


def test_clean_rejects_nan_and_nonfinite():
    assert _clean(float("nan")) is None
    assert _clean(float("inf")) is None
    assert _clean(1.5) == 1.5
    assert _clean(None) is None
    assert _clean(True) is True
    assert _clean({"a": float("nan")}) == {"a": None}
    assert _clean([1, float("inf")]) == [1, None]


def test_slim_item_only_known_fields_plus_snippet():
    item = {
        "id": 1, "title": "T", "snippet": "S" * 500, "weird": "drop", "headline": "H",
        "score_p": 0.5, "summarized": True,
    }
    out = slim_item(item)
    assert set(out) <= set(ITEM_FIELDS) | {"snippet"}
    assert out["id"] == 1
    assert out["headline"] == "H"
    assert len(out["snippet"]) == 320
    assert "weird" not in out


def test_atomic_never_leaves_tmp():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "progress.json"
        prog = Progress(p)
        prog.phase("editing")
        assert not any(tmp.name.startswith(p.name + ".tmp") for tmp in p.parent.iterdir())
        assert p.exists()


def test_no_path_never_raises():
    prog = Progress(None)  # type: ignore[arg-type]
    prog.phase("selecting")
    prog.desk_init("x", "X", 1)
    prog.desk_raw("x", [{"id": 1, "title": "T", "snippet": "S"}])
    prog.desk_edited("x", [{"id": 1, "headline": "H", "blurb": "B"}], "d")
    assert prog.data["desks"]["x"]["stage"] == "edited"
    assert prog.data["desks"]["x"]["deck"] == "d"


if __name__ == "__main__":
    import traceback
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {t.__name__}\n{traceback.format_exc()}")
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    raise SystemExit(1 if failed else 0)
