"""SQLite persistence for the daily brief (stdlib only).

Replaces state.json / issue-history.json / {date}.json.  The Node server opens the same
file, so every write here is a SHORT transaction (BEGIN IMMEDIATE ... COMMIT) and the
connection uses WAL + a long busy_timeout.

Public API (all take the connection returned by :func:`connect`):
    load_pool, upsert_pool, delete_pool, prune_pool       candidate_pool
    same_day_counts                                       in-memory rollback helper
    insert_brief, append_brief                            briefs + stories
"""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import sqlite3
from collections import Counter
from pathlib import Path

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "schema.sql"
UTC = dt.timezone.utc


def connect(path) -> sqlite3.Connection:
    # isolation_level=None => autocommit; we issue BEGIN IMMEDIATE ourselves (see tx()).
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))
    return conn


@contextlib.contextmanager
def tx(conn: sqlite3.Connection):
    """Write transaction. IMMEDIATE takes the write lock up front, so a concurrent
    node/python writer waits (busy_timeout) instead of failing on a read->write upgrade."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


# --------------------------------------------------------------------------- candidate_pool

def _parse(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def _age_days(row, now: dt.datetime) -> float:
    d = _parse(row["published"]) or _parse(row["first_seen"]) or now
    return max(0.0, (now - d).total_seconds() / 86400)


def load_pool(conn) -> list[dict]:
    """Pool as dicts shaped exactly like the old state['items'] values (key 'id', not 'item_id')."""
    out = []
    for r in conn.execute("SELECT * FROM candidate_pool"):
        d = dict(r)
        d["id"] = d.pop("item_id")
        out.append(d)
    return out


def upsert_pool(conn, fresh: list[dict], now: dt.datetime) -> int:
    """Port of merge_pool (without pruning). Existing rows are RE-CLASSIFIED (rel/subtopic/desk/
    source_type) but keep their counters; an empty snippet is filled. Returns #new rows."""
    existing = {r[0] for r in conn.execute("SELECT item_id FROM candidate_pool")}
    added = 0
    with tx(conn):
        for it in fresh:
            if it["id"] not in existing:
                added += 1
                existing.add(it["id"])
            conn.execute(
                """INSERT INTO candidate_pool
                     (item_id,url,title,snippet,published,source,source_type,subtopic,desk,rel,first_seen)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(item_id) DO UPDATE SET
                     rel=excluded.rel, subtopic=excluded.subtopic, desk=excluded.desk,
                     source_type=excluded.source_type,
                     snippet=CASE WHEN candidate_pool.snippet='' THEN excluded.snippet
                                  ELSE candidate_pool.snippet END""",
                (it["id"], it["url"], it["title"], it.get("snippet") or "", it.get("published"),
                 it["source"], it.get("source_type", "commentary"), it["subtopic"], it["desk"],
                 it["rel"], now.isoformat()),
            )
            # Upsert authors into item_meta (survives pool pruning)
            authors_json = json.dumps(it.get("authors") or [], ensure_ascii=False)
            if authors_json != "[]":
                conn.execute(
                    """INSERT INTO item_meta(item_id, authors) VALUES (?,?)
                       ON CONFLICT(item_id) DO UPDATE SET authors=excluded.authors WHERE excluded.authors <> '[]'""",
                    (it["id"], authors_json),
                )
    return added


def delete_pool(conn, ids) -> None:
    ids = [(i,) for i in ids]
    if ids:
        with tx(conn):
            conn.executemany("DELETE FROM candidate_pool WHERE item_id=?", ids)


def prune_pool(conn, now: dt.datetime, max_age_days: float) -> int:
    rows = conn.execute("SELECT item_id, published, first_seen FROM candidate_pool").fetchall()
    stale = [(r["item_id"],) for r in rows if _age_days(r, now) > max_age_days]
    if stale:
        with tx(conn):
            conn.executemany("DELETE FROM candidate_pool WHERE item_id=?", stale)
    return len(stale)


# --------------------------------------------------------------------------- same-day regeneration

def same_day_counts(conn, date_key: str) -> tuple[Counter, Counter]:
    """(shown, rejected) counts contributed to the pool by still-counted briefs of `date_key`.

    brief.py subtracts these from the in-memory pool before selection so a same-day rerun does not
    treat today's earlier edition as 'already shown' -- WITHOUT touching the DB. The real decrement
    happens inside append_brief's transaction, so a failed run leaves the DB exactly as it was.
    """
    shown, rejected = Counter(), Counter()
    for b in conn.execute("SELECT brief_id, rejected_ids FROM briefs WHERE date=? AND counted=1",
                          (date_key,)).fetchall():
        for r in conn.execute("SELECT item_id FROM stories WHERE brief_id=?", (b["brief_id"],)).fetchall():
            shown[r[0]] += 1
        for i in json.loads(b["rejected_ids"]):
            rejected[i] += 1
    return shown, rejected


def _supersede_locked(conn, date_key: str) -> None:
    """Caller holds the write transaction."""
    shown, rejected = same_day_counts(conn, date_key)
    conn.executemany("UPDATE candidate_pool SET times_shown=MAX(times_shown-?,0) WHERE item_id=?",
                     [(n, i) for i, n in shown.items()])
    conn.executemany("UPDATE candidate_pool SET rejected=MAX(rejected-?,0) WHERE item_id=?",
                     [(n, i) for i, n in rejected.items()])
    conn.execute("UPDATE briefs SET counted=0 WHERE date=? AND counted=1", (date_key,))


# --------------------------------------------------------------------------- briefs + stories

_CARRY = """
UPDATE stories SET
  liked    = COALESCE((SELECT s2.liked    FROM stories s2 JOIN briefs b2 ON b2.brief_id=s2.brief_id
                       WHERE b2.date=:date AND s2.brief_id<:bid AND s2.item_id=stories.item_id
                       ORDER BY s2.brief_id DESC LIMIT 1), 0),
  saved    = COALESCE((SELECT s2.saved    FROM stories s2 JOIN briefs b2 ON b2.brief_id=s2.brief_id
                       WHERE b2.date=:date AND s2.brief_id<:bid AND s2.item_id=stories.item_id
                       ORDER BY s2.brief_id DESC LIMIT 1), 0),
  liked_at = (SELECT s2.liked_at FROM stories s2 JOIN briefs b2 ON b2.brief_id=s2.brief_id
              WHERE b2.date=:date AND s2.brief_id<:bid AND s2.item_id=stories.item_id
              ORDER BY s2.brief_id DESC LIMIT 1),
  saved_at = (SELECT s2.saved_at FROM stories s2 JOIN briefs b2 ON b2.brief_id=s2.brief_id
              WHERE b2.date=:date AND s2.brief_id<:bid AND s2.item_id=stories.item_id
              ORDER BY s2.brief_id DESC LIMIT 1)
WHERE brief_id=:bid
"""


def insert_brief(conn, *, date_key: str, generated_at: str, model: str, llm_requests: int,
                 rejected_ids: list[str], desks_out: dict, meta: dict,
                 edition: int | None = None, counted: int = 1) -> int:
    """Insert one briefs row + its stories. Caller holds the transaction. No pool counter changes.

    desks_out = {desk_key: {"title","deck","stories":[story dict, ...]}} -- story dicts are what
    agent.apply_editor returns (pool fields + headline/blurb/why_care/tags/significance/summarized,
    plus kind/mode).  Feedback (liked/saved) is carried forward from earlier briefs of the same date
    (latest earlier occurrence of the item wins), preserving what the old {date}.json did.
    """
    if edition is None:
        n = conn.execute("SELECT COUNT(DISTINCT date) FROM briefs WHERE date<>?", (date_key,)).fetchone()[0]
        edition = n + 1
    desks_meta = {k: {"title": v["title"], "deck": v["deck"]} for k, v in desks_out.items()}
    cur = conn.execute(
        """INSERT INTO briefs (date,edition,generated_at,model,llm_requests,counted,rejected_ids,desks,meta)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (date_key, edition, generated_at, model, llm_requests, counted,
         json.dumps(rejected_ids), json.dumps(desks_meta, ensure_ascii=False),
         json.dumps(meta, ensure_ascii=False)),
    )
    bid = cur.lastrowid
    for desk, d in desks_out.items():
        for pos, s in enumerate(d["stories"]):
            conn.execute(
                """INSERT INTO stories
                     (brief_id,item_id,desk,position,headline,blurb,why_care,tags,significance,summarized,
                      url,source,source_type,subtopic,kind,mode,age_days,rel,times_shown_before)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (bid, s["id"], desk, pos, s["headline"], s["blurb"], s.get("why_care", ""),
                 json.dumps(s.get("tags", []), ensure_ascii=False), int(s.get("significance", 3)),
                 int(bool(s.get("summarized", True))), s["url"], s["source"],
                 s.get("source_type") or "commentary", s["subtopic"], s.get("kind", "fresh"),
                 s.get("mode"), float(s.get("age_days", 0)), float(s.get("rel", 0)),
                 int(s.get("times_shown", 0))),
            )
    conn.execute(_CARRY, {"date": date_key, "bid": bid})
    return bid


def append_brief(conn, *, date_key: str, now: dt.datetime, model: str, llm_requests: int,
                 rejected_ids: list[str], desks_out: dict, meta: dict) -> int:
    """The ONE write at the end of a successful generation: supersede same-day briefs, insert the
    new brief, bump shown/rejected counters -- atomically. Returns brief_id."""
    ts = now.isoformat()
    with tx(conn):
        _supersede_locked(conn, date_key)
        bid = insert_brief(conn, date_key=date_key, generated_at=ts, model=model,
                           llm_requests=llm_requests, rejected_ids=rejected_ids,
                           desks_out=desks_out, meta=meta)
        shown = [s["id"] for d in desks_out.values() for s in d["stories"]]
        conn.executemany("UPDATE candidate_pool SET times_shown=times_shown+1, last_shown=? WHERE item_id=?",
                         [(ts, i) for i in shown])
        conn.executemany("UPDATE candidate_pool SET rejected=rejected+1 WHERE item_id=?",
                         [(i,) for i in rejected_ids])
    return bid
