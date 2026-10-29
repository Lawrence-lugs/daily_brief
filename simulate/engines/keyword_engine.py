"""Keyword Engine implementation - wraps src.selection logic."""
from __future__ import annotations
import random
import math
from typing import List, Dict, Any
from simulate.core.engine import Engine, SelectionResult


# Defaults from src/selection.py
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


def freshness(age_days: float, cfg: Dict) -> float:
    """Logistic in log-age: f(a) = sigmoid((ln a50 - ln a) / s). f(a50) = 0.5."""
    a = max(age_days, cfg["age_floor_days"])
    z = (math.log(cfg["a50_days"]) - math.log(a)) / cfg["slope"]
    return 1.0 / (1.0 + math.exp(-z))


def _penalty(item: Dict, cfg: Dict) -> float:
    return (cfg["shown_decay"] ** item.get("times_shown", 0)) * (
        cfg["rejected_decay"] ** item.get("rejected", 0)
    )


def greedy_score(item: Dict, cfg: Dict) -> float:
    return item["rel"] * freshness(item["age_days"], cfg) * _penalty(item, cfg)


def explore_weight(item: Dict, cfg: Dict) -> float:
    """Flattened freshness (f ** gamma) so old items keep a real chance when exploring."""
    return item["rel"] * (freshness(item["age_days"], cfg) ** cfg["explore_gamma"]) * _penalty(item, cfg)


def _draw(pool: List[Dict], cfg: Dict, rng: random.Random) -> tuple[Dict, str]:
    """One epsilon-greedy draw from a non-empty pool."""
    if rng.random() < cfg["epsilon"]:
        weights = [explore_weight(i, cfg) for i in pool]
        total = sum(weights)
        if total > 0:
            return rng.choices(pool, weights=weights, k=1)[0], "explore"
    return max(pool, key=lambda i: greedy_score(i, cfg)), "greedy"


def pick_desk(
    candidates: List[Dict],
    subtopics: List[str],
    n: int,
    cfg: Dict,
    rng: random.Random,
    minimum_types: Dict[str, int] | None = None,
) -> List[tuple[Dict, str]]:
    """Choose up to n items for one desk.
    
    Subtopic balance: before each draw, the subtopics are ranked by how many items they have
    already contributed (fewest first, random tie-break) and the draw is restricted to the first
    subtopic that still has candidates.
    
    Returns [(item, mode)] in pick order, mode in {"greedy", "explore"}.
    """
    skip_exhausted = bool(cfg.get("skip_exhausted_subtopics", True))
    remaining = [c for c in candidates if c["subtopic"] in subtopics]
    counts = {s: 0 for s in subtopics}
    type_counts: Dict[str, int] = {}
    picks: List[tuple[Dict, str]] = []

    while remaining and len(picks) < n:
        needed_types = {
            kind for kind, minimum in (minimum_types or {}).items()
            if type_counts.get(kind, 0) < minimum
            and any(c.get("source_type") == kind for c in remaining)
        }
        pools: Dict[str, List[Dict]] = {}
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
    candidates: List[Dict],
    taken_ids: set[str],
    k: int,
    cfg: Dict,
    minimum_types: Dict[str, int] | None = None,
) -> List[Dict]:
    """Top-k greedy leftovers, with optional source-type coverage for editor backfill."""
    left = [c for c in candidates if c["id"] not in taken_ids]
    left.sort(key=lambda i: greedy_score(i, cfg), reverse=True)
    reserves: List[Dict] = []
    for kind, minimum in (minimum_types or {}).items():
        matching = [c for c in left if c.get("source_type") == kind]
        for item in matching[:minimum]:
            if len(reserves) >= k:
                break
            reserves.append(item)
            left.remove(item)
    return (reserves + left)[:k]


class KeywordEngine(Engine):
    """Keyword-based selection engine (legacy).
    
    Uses epsilon-greedy with:
    - Keyword relevance (rel) as base score
    - Logistic freshness decay (half-life ~7 days)
    - Subtopic balancing (round-robin across subtopics)
    - Source type minimum guarantees
    - Penalties for times_shown and rejected
    """
    
    def __init__(self, config: Dict | None = None, desk_config: Dict | None = None):
        self.config = {**DEFAULTS, **(config or {})}
        self.desk_config = desk_config or {
            "primary": {"subtopics": ["dse", "accel", "fab"], "title": "Silicon & Architecture Desk"},
            "science": {"subtopics": ["gr", "qft", "condmat", "neuro"], "title": "Science Desk"},
        }
    
    @property
    def name(self) -> str:
        return "keyword"
    
    def select(self, pool: List[Dict], config: Dict, seed: int) -> Dict[str, List[Dict]]:
        """Run keyword selection on the pool.
        
        Args:
            pool: List of candidate dicts with keys: id, rel, age_days, subtopic, 
                  source_type, times_shown, rejected
            config: Configuration overrides
            seed: Random seed
            
        Returns:
            Dict with 'primary' and 'science' keys, each a list of selected items
            with added 'mode' field (greedy/explore/reserve)
        """
        cfg = {**self.config, **config}
        rng = random.Random(seed)
        
        primary_n = cfg.get("primary_slots", 5)
        science_n = cfg.get("science_slots", 5)
        reserve_k = cfg.get("reserve_slots", 25)
        
        # Minimum types per desk (from brief.py)
        # primary: newslike=1, paperlike=2 (but we use researchlike)
        # science: newslike=1
        primary_min_types = cfg.get("primary_min_types", {"researchlike": 2, "newslike": 1})
        science_min_types = cfg.get("science_min_types", {"newslike": 1})
        
        # Pick primary desk
        primary_subtopics = self.desk_config["primary"]["subtopics"]
        primary_picks = pick_desk(pool, primary_subtopics, primary_n, cfg, rng, primary_min_types)
        
        # Pick science desk
        taken_ids = {item["id"] for item, _ in primary_picks}
        science_subtopics = self.desk_config["science"]["subtopics"]
        science_picks = pick_desk(
            [c for c in pool if c["id"] not in taken_ids],
            science_subtopics, science_n, cfg, rng, science_min_types
        )
        
        # Pick reserves (global pool, not per-desk)
        all_taken = taken_ids | {item["id"] for item, _ in science_picks}
        reserves = pick_reserves(pool, all_taken, reserve_k, cfg)
        
        # Format output
        result = {}
        for desk_name, desk_spec in [("primary", self.desk_config["primary"]), 
                                      ("science", self.desk_config["science"])]:
            picks = primary_picks if desk_name == "primary" else science_picks
            formatted = []
            for item, mode in picks:
                formatted.append({**item, "mode": mode, "desk": desk_name})
            result[desk_name] = formatted
        
        # Reserves
        result["reserve"] = [{**item, "mode": "reserve", "desk": "reserve"} for item in reserves]
        
        return result


# For backward compatibility with the old API
def run_keyword_selection(pool: List[Dict], config: Dict, seed: int) -> Dict[str, List[Dict]]:
    """Standalone function for keyword selection."""
    engine = KeywordEngine(config)
    return engine.select(pool, config, seed)