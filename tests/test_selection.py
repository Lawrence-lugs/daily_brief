"""Migrated and extended unit tests for selection.py.

Migrated from the repo-root ``test_selection.py`` plus new
selection-evenness tests. selection.py is pure (no I/O), so these need no
network mocks. Every RNG draw uses a seeded ``random.Random`` so the suite is
fully deterministic.
"""
from __future__ import annotations

import random

import selection as S

SPARSE = {"dse": 0.5, "accel": 3, "fab": 3, "gr": 0.4, "qft": 0.4, "oshw": 0.8, "condmat": 1.2, "neuro": 1.2}
RICH = {"dse": 2, "accel": 5, "fab": 5, "gr": 2, "qft": 2, "oshw": 2, "condmat": 3, "neuro": 3}


# --------------------------------------------------------------------------- migrated from repo root

def test_freshness_curve(cfg):
    f = lambda a: S.freshness(a, cfg)
    assert abs(f(cfg["a50_days"]) - 0.5) < 1e-9
    ages = [0.1, 0.5, 1, 3, 7, 14, 30, 90, 365]
    vals = [f(a) for a in ages]
    assert all(x >= y for x, y in zip(vals, vals[1:])), "freshness must be non-increasing"
    assert f(0.01) == f(cfg["age_floor_days"]), "age floor"
    assert 0.80 < f(1) < 0.95 and 0.10 < f(30) < 0.30 and f(90) < 0.12
    assert f(365) > 0, "soft cap: never exactly zero"


def test_repeat_penalty(cfg):
    base = {"rel": 0.8, "age_days": 2.0, "subtopic": "dse"}
    s0 = S.greedy_score({**base, "times_shown": 0}, cfg)
    s1 = S.greedy_score({**base, "times_shown": 1}, cfg)
    assert abs(s1 / s0 - cfg["shown_decay"]) < 1e-9


def test_pure_greedy_prefers_fresh(cfg):
    cfg = {**cfg, "epsilon": 0.0}
    old = {"id": "old", "rel": 0.9, "age_days": 40, "subtopic": "dse"}
    new = {"id": "new", "rel": 0.6, "age_days": 1, "subtopic": "dse"}
    (item, mode), = S.pick_desk([old, new], ["dse"], 1, cfg, random.Random(0))
    assert item["id"] == "new" and mode == "greedy"


def test_pure_explore_sometimes_picks_old(cfg):
    cfg = {**cfg, "epsilon": 1.0}
    old = {"id": "old", "rel": 0.9, "age_days": 40, "subtopic": "dse"}
    new = {"id": "new", "rel": 0.6, "age_days": 1, "subtopic": "dse"}
    rng = random.Random(1)
    got = [S.pick_desk([old, new], ["dse"], 1, cfg, rng)[0][0]["id"] for _ in range(400)]
    assert 0.05 < got.count("old") / 400 < 0.7


def test_subtopic_balance_and_empty_subtopic(cfg):
    cfg = {**cfg, "epsilon": 0.0}
    pool = [{"id": f"{s}{i}", "rel": 0.7, "age_days": i, "subtopic": s}
            for s in ("a", "b") for i in range(5)]
    picks = S.pick_desk(pool, ["a", "b", "c"], 4, cfg, random.Random(0))
    subs = [p[0]["subtopic"] for p in picks]
    assert subs.count("a") == 2 and subs.count("b") == 2  # "c" is empty and skipped
    assert len(S.pick_desk(pool[:1], ["a", "b"], 5, cfg, random.Random(0))) == 1


def test_minimum_source_type_coverage_and_reserves(cfg):
    cfg = {**cfg, "epsilon": 0.0}
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


def test_simulation_is_sane(cfg):
    r = simulate(cfg)
    assert r["hist"]["0-1d"] + r["hist"]["1-3d"] > 0.30, "mostly recent"
    assert r["hist"]["30-infd"] > 0.0, "month-old items do surface"
    assert 0.1 < r["modes"]["explore"] / r["picks"] < 0.4, "explore share ~ epsilon"
    assert r["repeat_rate"] < 0.5


# --------------------------------------------------------------------------- selection evenness (new)

def test_pick_desk_distributes_across_subtopics(cfg):
    """Balance: n picks over m subtopics differ by at most one (round-robin)."""
    cfg = {**cfg, "epsilon": 0.0}
    pool = [{"id": f"{s}{i:02d}", "rel": 0.8, "age_days": 0.5, "subtopic": s}
            for s in ("dse", "accel", "fab") for i in range(20)]

    picks = S.pick_desk(pool, ["dse", "accel", "fab"], 6, cfg, random.Random(0))
    subs = [p[0]["subtopic"] for p in picks]
    assert len(picks) == 6
    assert subs.count("dse") == 2 and subs.count("accel") == 2 and subs.count("fab") == 2

    picks7 = S.pick_desk(pool, ["dse", "accel", "fab"], 7, cfg, random.Random(0))
    counts7 = {s: [p[0]["subtopic"] for p in picks7].count(s) for s in ("dse", "accel", "fab")}
    assert sum(counts7.values()) == 7
    assert max(counts7.values()) - min(counts7.values()) <= 1


def test_explore_still_spreads_across_subtopics(cfg):
    """With epsilon=1 every subtopic that has candidates still gets represented."""
    cfg = {**cfg, "epsilon": 1.0}
    pool = [{"id": f"{s}{i}", "rel": 0.5, "age_days": i, "subtopic": s}
            for s in ("gr", "qft", "condmat") for i in range(5)]
    picks = S.pick_desk(pool, ["gr", "qft", "condmat"], 9, cfg, random.Random(3))
    subs = [p[0]["subtopic"] for p in picks]
    assert len(picks) == 9
    assert set(subs) == {"gr", "qft", "condmat"}


def test_greedy_prefers_fresh_even_when_older_item_has_higher_rel(cfg):
    """Freshness can outweigh raw relevance under greedy."""
    cfg = {**cfg, "epsilon": 0.0}
    older_higher_rel = {"id": "old", "rel": 1.0, "age_days": 60, "subtopic": "dse"}
    fresher_lower_rel = {"id": "new", "rel": 0.4, "age_days": 1, "subtopic": "dse"}
    (item, _mode), = S.pick_desk([older_higher_rel, fresher_lower_rel], ["dse"], 1,
                                 cfg, random.Random(0))
    assert item["id"] == "new"


def test_repeat_penalty_reduces_repicks(cfg):
    """An already-shown item loses to an unshown alternative under greedy."""
    cfg = {**cfg, "epsilon": 0.0}
    shown = {"id": "shown", "rel": 0.9, "age_days": 1, "subtopic": "dse", "times_shown": 3}
    unseen = {"id": "unseen", "rel": 0.5, "age_days": 1, "subtopic": "dse", "times_shown": 0}
    picks = S.pick_desk([shown, unseen], ["dse"], 2, cfg, random.Random(0))
    assert [p[0]["id"] for p in picks] == ["unseen", "shown"]


def test_empty_subtopic_is_skipped_without_hole(cfg):
    """A subtopic with no candidates is skipped; the desk still fills from the rest."""
    cfg = {**cfg, "epsilon": 0.0}
    pool = [{"id": f"a{i}", "rel": 0.7, "age_days": i, "subtopic": "a"} for i in range(4)]
    picks = S.pick_desk(pool, ["a", "b"], 4, cfg, random.Random(0))
    assert len(picks) == 4
    assert all(p[0]["subtopic"] == "a" for p in picks)  # "b" left no hole

    assert S.pick_desk([], ["a", "b"], 4, cfg, random.Random(0)) == []


def test_explore_picks_old_items_deterministically(cfg):
    """Exploration flattens freshness, so a 60-day-old item is still drawn."""
    cfg = {**cfg, "epsilon": 1.0}
    old = {"id": "old", "rel": 0.9, "age_days": 60, "subtopic": "dse"}
    new = {"id": "new", "rel": 0.6, "age_days": 1, "subtopic": "dse"}
    rng = random.Random(11)
    got = [S.pick_desk([old, new], ["dse"], 1, cfg, rng)[0][0]["id"] for _ in range(200)]
    share = got.count("old") / 200
    assert 0.05 < share < 0.95, f"old-item share under explore was {share:.2f}"


def simulate(cfg, days: int = 150, n: int = 5, seed: int = 7, rates: dict | None = None) -> dict:
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
            for item, mode in S.pick_desk(pool, subs, n, cfg, rng):
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
