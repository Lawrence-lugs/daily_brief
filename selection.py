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
    "shown_decay": 0.1,
    "rejected_decay": 0.3,
    "archive_after_days": 7.0,
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
) -> list[tuple[dict, str]]:
    """Choose up to n items for one desk.

    Subtopic balance: before each draw, the subtopics are ranked by how many items they have
    already contributed (fewest first, random tie-break) and the draw is restricted to the first
    subtopic that still has candidates. An empty subtopic is skipped, so a quiet field never
    leaves a hole in the page.

    Returns [(item, mode)] in pick order, mode in {"greedy", "explore"}.
    """
    remaining = [c for c in candidates if c["subtopic"] in subtopics]
    counts = {s: 0 for s in subtopics}
    picks: list[tuple[dict, str]] = []

    while remaining and len(picks) < n:
        order = sorted(subtopics, key=lambda s: (counts[s], rng.random()))
        pool: list[dict] = []
        for s in order:
            pool = [c for c in remaining if c["subtopic"] == s]
            if pool:
                break
        if not pool:
            break
        item, mode = _draw(pool, cfg, rng)
        remaining.remove(item)
        counts[item["subtopic"]] += 1
        picks.append((item, mode))
    return picks


def pick_reserves(
    candidates: list[dict], taken_ids: set[str], k: int, cfg: dict
) -> list[dict]:
    """Top-k greedy leftovers, used to backfill when the LLM editor rejects items."""
    left = [c for c in candidates if c["id"] not in taken_ids]
    left.sort(key=lambda i: greedy_score(i, cfg), reverse=True)
    return left[:k]


def kind_of(item: dict, cfg: dict) -> str:
    return "archive" if item["age_days"] > cfg["archive_after_days"] else "fresh"
