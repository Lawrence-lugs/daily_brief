"""Tests + simulation for selection.py.

    python test_selection.py          # assertions
    python test_selection.py --sim    # also print the simulated age distribution
"""
from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

import selection as S

CFG = {**S.DEFAULTS, **json.loads((Path(__file__).parent / "config.json").read_text())["selection"]}


def test_freshness_curve():
    f = lambda a: S.freshness(a, CFG)
    assert abs(f(CFG["a50_days"]) - 0.5) < 1e-9
    ages = [0.1, 0.5, 1, 3, 7, 14, 30, 90, 365]
    vals = [f(a) for a in ages]
    assert all(x >= y for x, y in zip(vals, vals[1:])), "freshness must be non-increasing"
    assert f(0.01) == f(CFG["age_floor_days"]), "age floor"
    assert 0.80 < f(1) < 0.95 and 0.10 < f(30) < 0.30 and f(90) < 0.12
    assert f(365) > 0, "soft cap: never exactly zero"


def test_repeat_penalty():
    base = {"rel": 0.8, "age_days": 2.0, "subtopic": "dse"}
    s0 = S.greedy_score({**base, "times_shown": 0}, CFG)
    s1 = S.greedy_score({**base, "times_shown": 1}, CFG)
    assert abs(s1 / s0 - CFG["shown_decay"]) < 1e-9


def test_pure_greedy_prefers_fresh():
    cfg = {**CFG, "epsilon": 0.0}
    old = {"id": "old", "rel": 0.9, "age_days": 40, "subtopic": "dse"}
    new = {"id": "new", "rel": 0.6, "age_days": 1, "subtopic": "dse"}
    (item, mode), = S.pick_desk([old, new], ["dse"], 1, cfg, random.Random(0))
    assert item["id"] == "new" and mode == "greedy"


def test_pure_explore_sometimes_picks_old():
    cfg = {**CFG, "epsilon": 1.0}
    old = {"id": "old", "rel": 0.9, "age_days": 40, "subtopic": "dse"}
    new = {"id": "new", "rel": 0.6, "age_days": 1, "subtopic": "dse"}
    rng = random.Random(1)
    got = [S.pick_desk([old, new], ["dse"], 1, cfg, rng)[0][0]["id"] for _ in range(400)]
    assert 0.05 < got.count("old") / 400 < 0.7


def test_subtopic_balance_and_empty_subtopic():
    cfg = {**CFG, "epsilon": 0.0}
    pool = [{"id": f"{s}{i}", "rel": 0.7, "age_days": i, "subtopic": s}
            for s in ("a", "b") for i in range(5)]
    picks = S.pick_desk(pool, ["a", "b", "c"], 4, cfg, random.Random(0))
    subs = [p[0]["subtopic"] for p in picks]
    assert subs.count("a") == 2 and subs.count("b") == 2  # "c" is empty and skipped
    assert len(S.pick_desk(pool[:1], ["a", "b"], 5, cfg, random.Random(0))) == 1


def test_minimum_source_type_coverage_and_reserves():
    cfg = {**CFG, "epsilon": 0.0}
    candidates = [
        {"id": "research", "rel": 1.0, "age_days": 0, "subtopic": "a",
         "source_type": "researchlike"},
        {"id": "news", "rel": 0.1, "age_days": 0, "subtopic": "a",
         "source_type": "newslike"},
        {"id": "commentary", "rel": 0.8, "age_days": 0, "subtopic": "a",
         "source_type": "commentary"},
    ]
    picks = S.pick_desk(candidates, ["a"], 1, cfg, random.Random(0),
                        minimum_types={"newslike": 1})
    assert picks[0][0]["source_type"] == "newslike"
    reserves = S.pick_reserves(candidates, {"research", "commentary"},
                               1, cfg, minimum_types={"newslike": 1})
    assert len(reserves) == 1 and reserves[0]["source_type"] == "newslike"


SPARSE = {"dse": 0.5, "accel": 3, "fab": 3, "gr": 0.4, "qft": 0.4, "oshw": 0.8, "condmat": 1.2, "neuro": 1.2}
RICH = {"dse": 2, "accel": 5, "fab": 5, "gr": 2, "qft": 2, "oshw": 2, "condmat": 3, "neuro": 3}


def simulate(days: int = 150, n: int = 5, seed: int = 7, rates: dict | None = None) -> dict:
    """Synthetic world: items arrive at different rates per subtopic. Reports the age of picks."""
    rng = random.Random(seed)
    rates = rates or SPARSE
    desks = {"primary": ["dse", "accel", "fab"], "science": ["gr", "qft", "oshw", "condmat", "neuro"]}
    pool: list[dict] = []
    nid = 0
    ages: list[float] = []
    modes = {"greedy": 0, "explore": 0}
    repeats = 0
    picked_total = 0
    warm = 30  # ignore the first month (pool still filling)
    for day in range(days):
        for s, lam in rates.items():
            k = sum(1 for _ in range(int(lam * 4)) if rng.random() < 0.25)  # ~Poisson(lam)
            for _ in range(k):
                pool.append({"id": nid, "rel": rng.uniform(0.4, 1.0), "born": day,
                             "subtopic": s, "times_shown": 0, "rejected": 0})
                nid += 1
        pool = [p for p in pool if day - p["born"] <= 120]
        for p in pool:
            p["age_days"] = float(day - p["born"]) + rng.random()
        for _, subs in desks.items():
            for item, mode in S.pick_desk(pool, subs, n, CFG, rng):
                if day >= warm:
                    ages.append(item["age_days"])
                    modes[mode] += 1
                    picked_total += 1
                    repeats += item["times_shown"] > 0
                item["times_shown"] += 1
    bins = [(0, 1), (1, 3), (3, 7), (7, 14), (14, 30), (30, 10_000)]
    hist = {f"{lo}-{hi if hi < 10_000 else 'inf'}d": sum(lo <= a < hi for a in ages) / len(ages)
            for lo, hi in bins}
    return {"hist": hist, "modes": modes, "repeat_rate": repeats / picked_total,
            "mean_age": sum(ages) / len(ages), "picks": picked_total}


def test_simulation_is_sane():
    r = simulate()
    assert r["hist"]["0-1d"] + r["hist"]["1-3d"] > 0.30, "mostly recent"
    assert r["hist"]["30-infd"] > 0.0, "month-old items do surface"
    assert 0.1 < r["modes"]["explore"] / r["picks"] < 0.4, "explore share ~ epsilon"
    assert r["repeat_rate"] < 0.5


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    if "--sim" in sys.argv:
        print("\nfreshness f(age):")
        for a in (0.25, 1, 3, 7, 14, 30, 60, 90, 180):
            print(f"  {a:>5} d  {S.freshness(a, CFG):.3f}  {'#' * int(S.freshness(a, CFG) * 40)}")
        scenarios = (
            ("SPARSE feeds (gr 0.4, qft 0.4, dse 0.5 items/day ...)", SPARSE),
            ("RICH feeds (2-5 items/day per subtopic)", RICH),
        )
        for label, rates in scenarios:
            r = simulate(rates=rates)
            print(f"\n{label}: {r['picks']} picks over 120 steady-state days, "
                  f"epsilon={CFG['epsilon']}, a50={CFG['a50_days']}d")
            for k, v in r["hist"].items():
                print(f"  age {k:>8}  {v:6.1%}  {'#' * int(v * 60)}")
            print(f"  explore picks {r['modes']['explore'] / r['picks']:.1%}   "
                  f"repeat rate {r['repeat_rate']:.1%}   mean age {r['mean_age']:.1f} d")