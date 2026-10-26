#!/usr/bin/env python3
"""One-shot import of the legacy files into the SQLite DB (stdlib only).

    python src/migrate_to_sqlite.py --edition-dir 05-for-agents/daily-brief [--state state.json] [--db X.db] [--force]

Reads   state.json                 -> candidate_pool (counters preserved, NOT re-bumped)
        <edition-dir>/issue-history.json -> briefs + stories (last entry of each date is `counted`)
        <edition-dir>/YYYY-MM-DD.json    -> stories.liked / stories.saved (matched by item id)
Refuses to run into a non-empty DB unless --force (which wipes briefs/stories/candidate_pool first).
localStorage marks from the old web version are not recoverable and are ignored.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
POOL_DEFAULTS = {"snippet": "", "published": None, "source_type": "commentary", "times_shown": 0,
                 "rejected": 0, "last_shown": None}


def load(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--edition-dir", required=True)
    ap.add_argument("--state", default=str(PROJECT_ROOT / "state.json"))
    ap.add_argument("--db")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    cfg = load(PROJECT_ROOT / "config.json", {})
    db_path = Path(a.db) if a.db else PROJECT_ROOT / cfg.get("db_file", "daily_brief.db")
    ed = Path(a.edition_dir)
    state = load(Path(a.state), {"items": {}, "editions": {}})
    history = sorted(load(ed / "issue-history.json", []), key=lambda e: e.get("generated", ""))

    conn = db.connect(db_path)
    nonempty = any(conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                   for t in ("candidate_pool", "briefs"))
    if nonempty and not a.force:
        print(f"{db_path} is not empty; use --force to wipe and re-import", file=sys.stderr)
        return 1

    last_per_date = {e["date"]: e["generated"] for e in history}
    n_pool = n_briefs = n_marks = 0
    with db.tx(conn):
        if a.force:
            for t in ("stories", "briefs", "candidate_pool"):
                conn.execute(f"DELETE FROM {t}")
        for iid, it in state["items"].items():
            row = {**POOL_DEFAULTS, **it}
            conn.execute(
                """INSERT OR REPLACE INTO candidate_pool
                   (item_id,url,title,snippet,published,source,source_type,subtopic,desk,rel,
                    first_seen,times_shown,rejected,last_shown) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (row.get("id", iid), row["url"], row["title"], row["snippet"], row["published"],
                 row["source"], row["source_type"], row["subtopic"], row["desk"], row["rel"],
                 row["first_seen"], row["times_shown"], row["rejected"], row["last_shown"]))
            n_pool += 1
        for e in history:
            desks = e.get("desks")
            if not isinstance(desks, dict) or not desks:
                continue
            is_last = last_per_date[e["date"]] == e["generated"]
            rej = state.get("editions", {}).get(e["date"], {}).get("rejected_ids", []) if is_last else []
            db.insert_brief(conn, date_key=e["date"], generated_at=e["generated"],
                            model=e.get("model", "unknown"),
                            llm_requests=state.get("editions", {}).get(e["date"], {}).get("llm_requests", 0),
                            rejected_ids=rej, desks_out=desks, meta=e.get("meta", {}),
                            edition=e.get("edition"), counted=1 if is_last else 0)
            n_briefs += 1
        for f in sorted(ed.glob("*.json")):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", f.stem):
                continue  # skips issue-history.json
            marks = (load(f, {}) or {}).get("stories", {})
            ts = dt.datetime.fromtimestamp(f.stat().st_mtime, dt.timezone.utc).isoformat()
            for item_id, m in marks.items():
                liked, saved = int(bool(m.get("liked"))), int(bool(m.get("saved")))
                if liked or saved:
                    cur = conn.execute(
                        """UPDATE stories SET liked=?, saved=?, liked_at=?, saved_at=?
                           WHERE item_id=? AND brief_id IN (SELECT brief_id FROM briefs WHERE date=?)""",
                        (liked, saved, ts if liked else None, ts if saved else None, item_id, f.stem))
                    n_marks += cur.rowcount
    print(f"imported pool={n_pool} briefs={n_briefs} feedback_rows_updated={n_marks} -> {db_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
