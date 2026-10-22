#!/usr/bin/env python3
"""Daily research brief generator (stdlib only).

    python brief.py                 # full run: fetch -> select -> LLM -> render
    python brief.py --no-llm        # offline edition from raw snippets (no OpenRouter calls)
    python brief.py --no-fetch      # reuse the persisted pool, skip the network fetch
    python brief.py --dry-run       # do everything but do not persist state
    python brief.py --seed 3        # reproducible epsilon-greedy draws

Pipeline: fetch real feeds -> normalize/classify -> merge into persistent pool (state.json)
-> epsilon-greedy select per desk (selection.py) -> LLM edits + summarizes -> render Tailwind
template -> write 05-for-agents/daily-brief/YYYY-MM-DD.html -> persist state.

The model never supplies URLs or items; it only ranks and writes about candidates we fetched.
See README.md for the design.

Modules:
    util.py           shared logging/warnings state
    fetch/fetcher.py  Fetcher base class, HTTP cache, generic throttler, feed parsers,
                      fetch_rss, FETCHERS registry, fetch_all, refresh_api_feeds
    fetch/semanticscholar.py SemanticScholarFetcher(Fetcher) + fetch_semanticscholar
    fetch/hn.py       legacy HN Algolia fetcher (migrated out; HN is now RSS)
    agent.py          LLM chat loop, extract_json/salvage_items, build_user_message, apply_editor
    selection.py      epsilon-greedy selection (unchanged)
    brief.py          thin orchestrator: state/pool, classify, render, main, CLI
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import selection as sel

import util
from util import WARNINGS, log, warn
from fetch.fetcher import (
    Fetcher,
    parse_date,
    canonical_url,
    parse_feed,
    fetch_rss,
    fetch_all,
    refresh_api_feeds,
    _iter_feed_specs,
)
from fetch.semanticscholar import fetch_semanticscholar
from agent import LLM, LLMUnavailable, extract_json, build_user_message, apply_editor

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE = Path.home() / ".cache" / "daily_brief"
STATE_FILE = PROJECT_ROOT / "state.json"
TEMPLATES = HERE / "templates"

UTC = dt.timezone.utc


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json_atomic(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- state / pool

def load_state() -> dict:
    return load_json(STATE_FILE, {"version": 1, "items": {}, "editions": {}})


def merge_pool(state: dict, fresh: list[dict], now: dt.datetime, max_age: float,
               dropped_ids: set[str] = frozenset()) -> int:
    added = 0
    pool = state["items"]
    for iid in dropped_ids:  # fetched again but no longer classified as relevant
        pool.pop(iid, None)
    for it in fresh:
        old = pool.get(it["id"])
        if old:
            # Re-fetched items are reclassified so keyword fixes take effect on existing pool entries.
            old["rel"], old["subtopic"], old["desk"] = it["rel"], it["subtopic"], it["desk"]
            old["source_type"] = it.get("source_type", "commentary")
            if not old.get("snippet") and it["snippet"]:
                old["snippet"] = it["snippet"]
            continue
        pool[it["id"]] = {
            **{k: it[k] for k in ("id", "url", "title", "snippet", "published", "source",
                                  "source_type", "subtopic", "desk", "rel")},
            "first_seen": now.isoformat(), "times_shown": 0, "rejected": 0, "last_shown": None,
        }
        added += 1
    for iid in list(pool):
        if age_days(pool[iid], now) > max_age:
            del pool[iid]
    return added


def age_days(item: dict, now: dt.datetime) -> float:
    d = parse_date(item.get("published")) or parse_date(item.get("first_seen")) or now
    return max(0.0, (now - d).total_seconds() / 86400)


def rollback_same_day(state: dict, date_key: str) -> None:
    """Re-running on the same day must not count the earlier edition as 'already shown'."""
    prev = state["editions"].get(date_key)
    if not prev:
        return
    for iid in prev.get("ids", []):
        it = state["items"].get(iid)
        if it and it["times_shown"] > 0:
            it["times_shown"] -= 1
    for iid in prev.get("rejected_ids", []):
        it = state["items"].get(iid)
        if it and it["rejected"] > 0:
            it["rejected"] -= 1


# --------------------------------------------------------------------------- classification

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


# --------------------------------------------------------------------------- rendering

class Raw(str):
    pass


def fill(tpl: str, **vals) -> str:
    def esc(v):
        return v if isinstance(v, Raw) else html.escape(str(v), quote=True)
    return re.sub(r"\{\{(\w+)\}\}", lambda m: esc(vals.get(m.group(1), "")), tpl)


def tpl(name: str) -> str:
    return (TEMPLATES / name).read_text(encoding="utf-8")


def age_label(s: dict) -> str:
    d = s["age_days"]
    if d < 1:
        return "today"
    if d < 2:
        return "yesterday"
    if d < 14:
        return f"{int(d)} days ago"
    if d < 60:
        return f"{int(d // 7)} weeks ago"
    return f"{int(d // 30)} months ago"


def safe_url(u: str) -> str:
    return u if u.startswith(("http://", "https://")) else "#"


def render_story(s: dict, lead: bool) -> str:
    tags = Raw("".join(fill(tpl("tag.html"), tag=t) for t in s["tags"]))
    badge = Raw(fill(tpl("badge.html"), label="From the archive")) if s["kind"] == "archive" else Raw("")
    why = Raw(fill(tpl("why.html"), why=s["why_care"])) if s["why_care"] else Raw("")
    raw_note = Raw("" if s["summarized"] else fill(tpl("badge.html"), label="Unedited"))
    return fill(tpl("lead.html" if lead else "story.html"),
                id=s.get("id", ""), headline=s["headline"], blurb=s["blurb"], url=safe_url(s["url"]), source=s["source"],
                age=age_label(s), tags=tags, badge=badge, why=why, raw_note=raw_note)


def render_desk(stories: list[dict]) -> str:
    return "".join(render_story(s, lead=(i == 0)) for i, s in enumerate(stories))


def render_page(cfg: dict, now: dt.datetime, edition_no: int, desks: dict, meta: dict) -> str:
    css = (PROJECT_ROOT / "tailwind.css").read_text(encoding="utf-8")
    local_now = now.astimezone()
    foot = (f"Edited by {meta['model']}. {meta['n_fresh']} recent, {meta['n_archive']} from the archive. "
            f"{meta['n_explore']} explore picks (epsilon {meta['epsilon']}). "
            f"Candidate pool: {meta['pool']} items. Sources: {meta['sources']}.")
    warn_html = Raw("".join(fill(tpl("warning.html"), text=w) for w in WARNINGS[:6]))
    return fill(
        tpl("page.html"),
        css=Raw(css), paper_name=cfg["paper_name"],
        date_long=local_now.strftime("%A, %B %d, %Y").replace(" 0", " "),
        edition=f"No. {edition_no}",
        generated=local_now.strftime("%H:%M"),
        primary_title=desks["primary"]["title"], primary_deck=desks["primary"]["deck"],
        primary_stories=Raw(render_desk(desks["primary"]["stories"])),
        science_title=desks["science"]["title"], science_deck=desks["science"]["deck"],
        science_stories=Raw(render_desk(desks["science"]["stories"])),
        warnings=warn_html, footer=foot,
    )


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--out", help="override output path")
    # --refresh-api-feeds is the hidden trigger used by the detached background
    # refresh process spawned by fetch_all.  The background refresh is on by
    # default; --no-refresh-api-feeds disables spawning it.
    ap.add_argument("--refresh-api-feeds", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--no-refresh-api-feeds", action="store_false", dest="refresh_api_auto",
                    default=True, help=argparse.SUPPRESS)
    ap.add_argument("--log-file", type=Path, help=argparse.SUPPRESS)
    args = ap.parse_args()
    util.LOG_FILE = args.log_file

    cfg = load_json(PROJECT_ROOT / "config.json")
    src = load_json(PROJECT_ROOT / "sources.json")

    if args.refresh_api_feeds:
        # Detached background refresh: fetch every "api" feed, classify, merge,
        # persist, then exit.  Results can be up to about a day old.
        items = refresh_api_feeds(cfg, src)
        sub2desk = {s: d for d, v in src["desks"].items() for s in v["subtopics"]}
        classified = []
        for it in items:
            c = classify(it, src["keywords"], sub2desk)
            if c is not None:
                classified.append(c)
        now = dt.datetime.now(UTC)
        # Re-read the latest state so a concurrent main-run update is not
        # clobbered; the pool merge is idempotent (keyed by item id).
        state = load_state()
        merge_pool(state, classified, now, cfg["pool"]["max_age_days"])
        save_json_atomic(STATE_FILE, state)
        return 0

    if not (PROJECT_ROOT / "tailwind.css").exists():
        util.log("tailwind.css missing. Run build_css.ps1 once (see README).")
        return 1
    scfg = {**sel.DEFAULTS, **cfg["selection"]}
    rng = random.Random(args.seed)
    now = dt.datetime.now(UTC)
    date_key = now.astimezone().strftime("%Y-%m-%d")
    sub2desk = {s: d for d, v in src["desks"].items() for s in v["subtopics"]}

    state = load_state()
    rollback_same_day(state, date_key)

    source_types = {}
    for spec in _iter_feed_specs(src.get("feeds", {})):
        source_types[spec["name"]] = spec.get("type", "commentary")
    for item in state["items"].values():
        item.setdefault("source_type", source_types.get(item["source"], "commentary"))

    # 1. fetch + classify + merge
    if args.no_fetch:
        util.log("skipping fetch; using persisted pool")
    else:
        raw = fetch_all(cfg, src, refresh_api=args.refresh_api_auto)
        classified, seen, dropped = [], {}, set()
        for it in raw:
            c = classify(it, src["keywords"], sub2desk)
            if c is None:
                dropped.add(it["id"])
            elif c["id"] not in seen or c["rel"] > seen[c["id"]]["rel"]:
                seen[c["id"]] = c
        classified = list(seen.values())
        added = merge_pool(state, classified, now, cfg["pool"]["max_age_days"], dropped - set(seen))
        util.log(f"classified {len(classified)}/{len(raw)} items, {added} new in pool")
    pool = list(state["items"].values())
    if not pool:
        util.log("pool is empty (all sources failed?)")
        return 1
    for p in pool:
        p["age_days"] = age_days(p, now)

    # 2. epsilon-greedy selection per desk
    n, k = cfg["stories_per_desk"], cfg["reserve_per_desk"]
    selected: dict[str, list[dict]] = {}
    modes = {"explore": 0, "greedy": 0}
    for desk, spec in src["desks"].items():
        cands_all = [p for p in pool if p["subtopic"] in spec["subtopics"]]
        picks = sel.pick_desk(cands_all, spec["subtopics"], n, scfg, rng,
                              minimum_types={"newslike": 1, "paperlike": 2})
        for item, mode in picks:
            modes[mode] += 1
        chosen = [dict(i, mode=m) for i, m in picks]
        reserve = [dict(i, mode="reserve") for i in sel.pick_reserves(
            cands_all, {i["id"] for i, _ in picks}, k, scfg,
            minimum_types={"newslike": 1},
        )]
        selected[desk] = chosen + reserve
        for c in selected[desk]:
            c["kind"] = sel.kind_of(c, scfg)
        util.log(f"{desk}: {len(chosen)} picked ({sum(1 for _, m in picks if m == 'explore')} explore) + {len(reserve)} reserve")

    # 3. LLM edit
    llm: LLM | None = None
    if not args.no_llm:
        try:
            llm = LLM(cfg["llm"])
            rem = llm.remaining_daily()
            if rem is not None and rem < cfg["llm"]["min_remaining_daily"]:
                raise LLMUnavailable(f"only {rem} free requests left today")
        except LLMUnavailable as e:
            util.warn(f"LLM skipped: {e}. Showing an unedited edition.")
            llm = None
    # Log every agent JSON response (success or failure) beside the output HTML
    # for debugging model JSON errors.  Both the HTML and the agent debug log
    # live beside each other at out_dir.  Default to edition_dir unless --out is
    # given, in which case --out is treated as the output directory and the
    # dated HTML is written inside it (so the Obsidian embed can point at the
    # same directory it reads from).
    if args.out:
        out_dir = Path(args.out)
        out_path = out_dir / f"{date_key}.html"
    else:
        out_path = PROJECT_ROOT / cfg["edition_dir"] / f"{date_key}.html"
        out_dir = out_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    LLM.DEBUG_LOG = out_dir / "agent_responses.jsonl"
    desks_out, all_rejected, shown_ids = {}, [], []
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
                util.warn(f"{spec['title']}: editor unavailable ({e}); showing raw items")
                if "cap" in str(e) or "HTTP 401" in str(e):
                    llm = None
            except Exception as e:  # one desk's editor failure must never kill the whole edition
                util.warn(f"{spec['title']}: editor errored ({type(e).__name__}: {e}); showing raw items")
                llm = None
        stories, rejected, deck = apply_editor(selected[desk], result, n)
        desks_out[desk] = {"title": spec["title"], "stories": stories,
                           "deck": deck or "Unedited candidates, ranked by relevance and freshness."}
        all_rejected += rejected
        shown_ids += [s["id"] for s in stories]

    # 4. render
    all_stories = [s for d in desks_out.values() for s in d["stories"]]
    edition_no = len(set(state["editions"]) | {date_key})
    models = sorted(set(llm.models)) if llm and llm.models else []
    meta = {
        "model": ", ".join(models) if models else "no model (raw items)",
        "n_fresh": sum(s["kind"] == "fresh" for s in all_stories),
        "n_archive": sum(s["kind"] == "archive" for s in all_stories),
        "n_explore": sum(s.get("mode") == "explore" for s in all_stories),
        "epsilon": scfg["epsilon"], "pool": len(pool),
        "sources": ", ".join(sorted({s["source"].split(":")[0] for s in all_stories})),
    }
    page = render_page(cfg, now, edition_no, desks_out, meta)
    out_path.write_text(page, encoding="utf-8")
    util.log(f"brief generation done: {out_path} ({len(all_stories)} stories, model={meta['model']}, "
             f"llm_requests={llm.requests if llm else 0})")

    # 5. persist state only after a successful write
    if not args.dry_run:
        for iid in shown_ids:
            it = state["items"].get(iid)
            if it:
                it["times_shown"] += 1
                it["last_shown"] = now.isoformat()
        for iid in all_rejected:
            if iid in state["items"]:
                state["items"][iid]["rejected"] += 1
        state["editions"][date_key] = {"ids": shown_ids, "rejected_ids": all_rejected,
                                       "generated": now.isoformat(), "model": meta["model"],
                                       "llm_requests": llm.requests if llm else 0}
        save_json_atomic(STATE_FILE, state)
    print(f"OK {out_path} ({len(all_stories)} stories, model={meta['model']}, "
          f"llm_requests={llm.requests if llm else 0})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # surface a one-line error for the Obsidian button
        util.log(f"FAILED: {type(e).__name__}: {e}")
        raise
