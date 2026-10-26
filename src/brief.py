#!/usr/bin/env python3
"""Daily research brief generator (stdlib only) -- SQLite edition.

    python brief.py                 # full run: fetch -> select -> LLM -> append to DB
    python brief.py --no-llm        # offline edition from raw snippets (no OpenRouter calls)
    python brief.py --no-fetch      # reuse the persisted pool, skip the network fetch
    python brief.py --dry-run       # do everything but do not write the brief / counters
    python brief.py --seed 3        # reproducible epsilon-greedy draws

Pipeline: fetch feeds -> classify -> upsert candidate_pool -> epsilon-greedy select per desk
(selection.py) -> LLM edits + summarizes -> db.append_brief (one atomic write).
HTML rendering now lives in the node server (server/lib/render.js); this file never writes HTML.

NOTE: fetch/fetcher.py does `from brief import Fetcher, CACHE`; keep those names exported here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import re
import sys
from pathlib import Path

import selection as sel

import util
import db
from util import log, warn
from fetch.fetcher import (  # noqa: F401  (Fetcher/CACHE are re-imported by fetcher.py)
    Fetcher,
    parse_date,
    fetch_all,
    refresh_api_feeds,
    _iter_feed_specs,
)
from fetch.semanticscholar import fetch_semanticscholar  # noqa: F401  (registers the api fetcher)
from agent import LLM, LLMUnavailable, build_user_message, apply_editor

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE = Path.home() / ".cache" / "daily_brief"
UTC = dt.timezone.utc


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def db_path(cfg: dict) -> Path:
    return PROJECT_ROOT / cfg.get("db_file", "daily_brief.db")


def age_days(item: dict, now: dt.datetime) -> float:
    d = parse_date(item.get("published")) or parse_date(item.get("first_seen")) or now
    return max(0.0, (now - d).total_seconds() / 86400)


# --------------------------------------------------------------------------- classification (unchanged)

_TERM_CACHE: dict[str, re.Pattern] = {}


def _term_regex(term: str) -> re.Pattern:
    """Word-start match; short terms (<= 4 chars, e.g. 'eda', 'dse', 'cim') must be whole words.
    Longer terms may be stems ('cosmolog', 'superconduct')."""
    p = _TERM_CACHE.get(term)
    if p is None:
        body = re.escape(term)
        p = re.compile(r"(?<![a-z0-9])" + body + (r"(?![a-z0-9])" if len(term) <= 4 else ""))
        _TERM_CACHE[term] = p
    return p


def classify(item: dict, keywords: dict, subtopic_to_desk: dict) -> dict | None:
    """Assign subtopic + rel in (0,1]. Returns None for off-topic items."""
    title = item["title"].lower()
    body = item["snippet"].lower()
    scores: dict[str, float] = {}
    for sub, terms in keywords.items():
        h = 0.0
        for t in terms:
            pat = _term_regex(t)
            if pat.search(title):
                h += 2
            elif pat.search(body):
                h += 1
        if h:
            scores[sub] = h
    hint = item["hint"]
    if hint and hint in keywords:
        # A source's own topical hint wins ties and acts as a mild prior.
        scores[hint] = scores.get(hint, 0) + 1.0
    if not scores:
        return None
    sub = max(scores, key=scores.get)
    hits = scores[sub]
    only_hint = hint == sub and hits <= 1.0
    kw = 0.3 if only_hint else min(1.0, hits / 4)
    if not hint and hits < 2:  # untargeted feed with a stray single keyword: skip
        return None
    item["subtopic"] = sub
    item["desk"] = subtopic_to_desk[sub]
    item["rel"] = round(max(0.05, min(1.0, item["weight"] * (0.3 + 0.7 * kw))), 4)
    return item


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--seed", type=int)
    # Hidden trigger used by the detached background refresh spawned by fetch_all.
    ap.add_argument("--refresh-api-feeds", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--no-refresh-api-feeds", action="store_false", dest="refresh_api_auto",
                    default=True, help=argparse.SUPPRESS)
    ap.add_argument("--log-file", type=Path, help=argparse.SUPPRESS)
    args = ap.parse_args()
    util.LOG_FILE = args.log_file

    cfg = load_json(PROJECT_ROOT / "config.json")
    src = load_json(PROJECT_ROOT / "sources.json")
    sub2desk = {s: d for d, v in src["desks"].items() for s in v["subtopics"]}
    conn = db.connect(db_path(cfg))
    max_age = cfg["pool"]["max_age_days"]

    if args.refresh_api_feeds:
        # Detached background refresh: fetch every "api" feed, classify, upsert, exit.
        items = refresh_api_feeds(cfg, src)
        classified = [c for c in (classify(it, src["keywords"], sub2desk) for it in items) if c]
        now = dt.datetime.now(UTC)
        db.upsert_pool(conn, classified, now)  # row-level upserts: safe against a concurrent main run
        db.prune_pool(conn, now, max_age)
        return 0

    scfg = {**sel.DEFAULTS, **cfg["selection"]}
    rng = random.Random(args.seed)
    now = dt.datetime.now(UTC)
    date_key = now.astimezone().strftime("%Y-%m-%d")

    # 1. fetch + classify + upsert
    if args.no_fetch:
        log("skipping fetch; using persisted pool")
    else:
        raw = fetch_all(cfg, src, refresh_api=args.refresh_api_auto)
        seen, dropped = {}, set()
        for it in raw:
            c = classify(it, src["keywords"], sub2desk)
            if c is None:
                dropped.add(it["id"])
            elif c["id"] not in seen or c["rel"] > seen[c["id"]]["rel"]:
                seen[c["id"]] = c
        classified = list(seen.values())
        added = db.upsert_pool(conn, classified, now)
        db.delete_pool(conn, dropped - set(seen))  # fetched again but no longer relevant
        db.prune_pool(conn, now, max_age)
        log(f"classified {len(classified)}/{len(raw)} items, {added} new in pool")
    pool = db.load_pool(conn)
    if not pool:
        log("pool is empty (all sources failed?)")
        return 1

    # Same-day rerun must not count today's earlier edition as 'already shown'. Adjust IN MEMORY only;
    # db.append_brief performs the real decrement atomically with the insert.
    sd_shown, sd_rej = db.same_day_counts(conn, date_key)
    for p in pool:
        p["times_shown"] = max(0, p["times_shown"] - sd_shown.get(p["id"], 0))
        p["rejected"] = max(0, p["rejected"] - sd_rej.get(p["id"], 0))
        p["age_days"] = age_days(p, now)

    # 2. epsilon-greedy selection per desk
    n, k = cfg["stories_per_desk"], cfg["reserve_per_desk"]
    selected: dict[str, list[dict]] = {}
    for desk, spec in src["desks"].items():
        cands_all = [p for p in pool if p["subtopic"] in spec["subtopics"]]
        picks = sel.pick_desk(cands_all, spec["subtopics"], n, scfg, rng,
                              minimum_types={"newslike": 1, "paperlike": 2})
        chosen = [dict(i, mode=m) for i, m in picks]
        reserve = [dict(i, mode="reserve") for i in sel.pick_reserves(
            cands_all, {i["id"] for i, _ in picks}, k, scfg, minimum_types={"newslike": 1})]
        selected[desk] = chosen + reserve
        for c in selected[desk]:
            c["kind"] = sel.kind_of(c, scfg)
        log(f"{desk}: {len(chosen)} picked ({sum(1 for _, m in picks if m == 'explore')} explore) "
            f"+ {len(reserve)} reserve")

    # 3. LLM edit
    llm: LLM | None = None
    if not args.no_llm:
        try:
            llm = LLM(cfg["llm"])
            rem = llm.remaining_daily()
            if rem is not None and rem < cfg["llm"]["min_remaining_daily"]:
                raise LLMUnavailable(f"only {rem} free requests left today")
        except LLMUnavailable as e:
            warn(f"LLM skipped: {e}. Showing an unedited edition.")
            llm = None
    debug_dir = PROJECT_ROOT / cfg.get("debug_dir", "logs")
    debug_dir.mkdir(parents=True, exist_ok=True)
    LLM.DEBUG_LOG = debug_dir / "agent_responses.jsonl"
    desks_out, all_rejected = {}, []
    today_s = now.astimezone().strftime("%A %Y-%m-%d")
    system = (PROJECT_ROOT / "prompt_system.md").read_text(encoding="utf-8")
    max_cap = int(cfg.get("max_agent_output_items_per_desk", n))
    system = system.replace("{{max_agent_output_items_per_desk}}", str(max_cap))
    for desk, spec in src["desks"].items():
        result = None
        if llm:
            try:
                result = llm.chat(system, build_user_message(spec["title"], n, selected[desk], today_s,
                                                             keep_cap=max_cap))
            except LLMUnavailable as e:
                warn(f"{spec['title']}: editor unavailable ({e}); showing raw items")
                if "cap" in str(e) or "HTTP 401" in str(e):
                    llm = None
            except Exception as e:  # one desk's editor failure must never kill the whole edition
                warn(f"{spec['title']}: editor errored ({type(e).__name__}: {e}); showing raw items")
                llm = None
        stories, rejected, deck = apply_editor(selected[desk], result, n)
        desks_out[desk] = {"title": spec["title"], "stories": stories,
                           "deck": deck or "Unedited candidates, ranked by relevance and freshness."}
        all_rejected += rejected

    # 4. persist (single atomic append)
    all_stories = [s for d in desks_out.values() for s in d["stories"]]
    models = sorted(set(llm.models)) if llm and llm.models else []
    meta = {
        "model": ", ".join(models) if models else "no model (raw items)",
        "n_fresh": sum(s["kind"] == "fresh" for s in all_stories),
        "n_archive": sum(s["kind"] == "archive" for s in all_stories),
        "n_explore": sum(s.get("mode") == "explore" for s in all_stories),
        "epsilon": scfg["epsilon"], "pool": len(pool),
        "sources": ", ".join(sorted({s["source"].split(":")[0] for s in all_stories})),
    }
    llm_requests = llm.requests if llm else 0
    if args.dry_run:
        print(f"DRY-RUN {len(all_stories)} stories, model={meta['model']}, llm_requests={llm_requests}")
        return 0
    brief_id = db.append_brief(conn, date_key=date_key, now=now, model=meta["model"],
                               llm_requests=llm_requests, rejected_ids=all_rejected,
                               desks_out=desks_out, meta=meta)
    log(f"brief generation done: brief_id={brief_id} ({len(all_stories)} stories, "
        f"model={meta['model']}, llm_requests={llm_requests})")  # jobs.js watches for this exact phrase
    print(f"OK brief_id={brief_id} ({len(all_stories)} stories, model={meta['model']}, "
          f"llm_requests={llm_requests})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        util.log(f"FAILED: {type(e).__name__}: {e}")
        raise
