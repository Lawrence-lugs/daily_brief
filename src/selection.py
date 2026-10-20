"""Epsilon-greedy item selection with soft (logistic) staleness.

Pure functions, no I/O, so the behaviour can be simulated (see test_selection.py).
The full write-up lives in README.md ("Selection: epsilon-greedy with soft staleness").

Item dict fields used here:
    rel          float in (0, 1]  base relevance from source weight + keyword match
    age_days     float >= 0       computed by the caller at selection time
    subtopic     str
    times_shown  int              editions this item has already appeared in
    rejected     int              times the LLM editor rejected it
"""
from __future__ import annotations

import math
import random
from typing import Callable

DEFAULTS = {
    "epsilon": 0.25,
    "a50_days": 7.0,
    "slope": 1.0,
    "age_floor_days": 0.25,
    "explore_gamma": 0.3,
    "shown_decay": 0.05,
    "rejected_decay": 0.3,
    "archive_after_days": 7.0,
    "skip_exhausted_subtopics": True,
}


def freshness(age_days: float, cfg: dict) -> float:
    """Logistic in log-age: f(a) = sigmoid((ln a50 - ln a) / s). f(a50) = 0.5."""
    a = max(age_days, cfg["age_floor_days"])
    z = (math.log(cfg["a50_days"]) - math.log(a)) / cfg["slope"]
    return 1.0 / (1.0 + math.exp(-z))


def _penalty(item: dict, cfg: dict) -> float:
    return (cfg["shown_decay"] ** item.get("times_shown", 0)) * (
        cfg["rejected_decay"] ** item.get("rejected", 0)
    )


def greedy_score(item: dict, cfg: dict) -> float:
    return item["rel"] * freshness(item["age_days"], cfg) * _penalty(item, cfg)


def explore_weight(item: dict, cfg: dict) -> float:
    """Flattened freshness (f ** gamma) so old items keep a real chance when exploring."""
    return item["rel"] * (freshness(item["age_days"], cfg) ** cfg["explore_gamma"]) * _penalty(item, cfg)


def _draw(pool: list[dict], cfg: dict, rng: random.Random) -> tuple[dict, str]:
    """One epsilon-greedy draw from a non-empty pool."""
    if rng.random() < cfg["epsilon"]:
        weights = [explore_weight(i, cfg) for i in pool]
        total = sum(weights)
        if total > 0:
            return rng.choices(pool, weights=weights, k=1)[0], "explore"
    return max(pool, key=lambda i: greedy_score(i, cfg)), "greedy"


def pick_desk(
    candidates: list[dict],
    subtopics: list[str],
    n: int,
    cfg: dict,
    rng: random.Random,
    minimum_types: dict[str, int] | None = None,
) -> list[tuple[dict, str]]:
    """Choose up to n items for one desk.

    Subtopic balance: before each draw, the subtopics are ranked by how many items they have
    already contributed (fewest first, random tie-break) and the draw is restricted to the first
    subtopic that still has candidates. An empty subtopic is skipped, so a quiet field never
    leaves a hole in the page.

    Repeat damping (soft cap): when `skip_exhausted_subtopics` is set, a subtopic whose *entire*
    candidate pool has already been shown (every candidate has times_shown >= 1) is passed over
    while any other subtopic still has an unseen candidate. Slow/sparse fields therefore go quiet
    instead of recycling the same old items day after day. If *every* subtopic is exhausted the
    restriction is lifted and selection falls back to the normal greedy/explore draw, so nothing
    is ever excluded outright.

    Returns [(item, mode)] in pick order, mode in {"greedy", "explore"}.
    """
    skip_exhausted = bool(cfg.get("skip_exhausted_subtopics", True))
    remaining = [c for c in candidates if c["subtopic"] in subtopics]
    counts = {s: 0 for s in subtopics}
    type_counts: dict[str, int] = {}
    picks: list[tuple[dict, str]] = []

    while remaining and len(picks) < n:
        needed_types = {
            kind for kind, minimum in (minimum_types or {}).items()
            if type_counts.get(kind, 0) < minimum
            and any(c.get("source_type") == kind for c in remaining)
        }
        pools: dict[str, list[dict]] = {}
        for s in subtopics:
            pools[s] = [
                c for c in remaining
                if c["subtopic"] == s and (not needed_types or c.get("source_type") in needed_types)
            ]
        nonempty = [s for s in subtopics if pools[s]]
        if not nonempty:
            break
        if skip_exhausted:
            fresh = [
                s for s in nonempty
                if any(c.get("times_shown", 0) == 0 for c in pools[s])
            ]
            order_pool = fresh if fresh else nonempty  # soft cap: fall back if all exhausted
        else:
            order_pool = nonempty
        order = sorted(order_pool, key=lambda s: (counts[s], rng.random()))
        pool = pools[order[0]]
        item, mode = _draw(pool, cfg, rng)
        remaining.remove(item)
        counts[item["subtopic"]] += 1
        item_type = item.get("source_type")
        if item_type:
            type_counts[item_type] = type_counts.get(item_type, 0) + 1
        picks.append((item, mode))
    return picks


def pick_reserves(
    candidates: list[dict],
    taken_ids: set[str],
    k: int,
    cfg: dict,
    minimum_types: dict[str, int] | None = None,
) -> list[dict]:
    """Top-k greedy leftovers, with optional source-type coverage for editor backfill."""
    left = [c for c in candidates if c["id"] not in taken_ids]
    left.sort(key=lambda i: greedy_score(i, cfg), reverse=True)
    reserves: list[dict] = []
    for kind, minimum in (minimum_types or {}).items():
        matching = [c for c in left if c.get("source_type") == kind]
        for item in matching[:minimum]:
            if len(reserves) >= k:
                break
            reserves.append(item)
            left.remove(item)
    return (reserves + left)[:k]


def kind_of(item: dict, cfg: dict) -> str:
    return "archive" if item["age_days"] > cfg["archive_after_days"] else "fresh"
