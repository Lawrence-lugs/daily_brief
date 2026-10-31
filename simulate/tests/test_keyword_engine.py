"""Tests for KeywordEngine and related functions."""
from __future__ import annotations
import pytest
import math
from unittest.mock import Mock, MagicMock, patch

from simulate.engines.keyword_engine import (
    KeywordEngine,
    freshness,
    _penalty,
    greedy_score,
    explore_weight,
    _draw,
    pick_desk,
    pick_reserves,
    run_keyword_selection,
    DEFAULTS,
)


class TestFreshness:
    """Tests for freshness function."""

    def test_freshness_at_a50(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        result = freshness(7.0, cfg)
        assert abs(result - 0.5) < 0.001

    def test_freshness_young(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        result = freshness(1.0, cfg)
        assert result > 0.5
        assert result < 1.0

    def test_freshness_old(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        result = freshness(100.0, cfg)
        assert result < 0.5
        assert result > 0.0

    def test_freshness_age_floor(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 1.0}
        result_at_floor = freshness(1.0, cfg)
        result_below = freshness(0.1, cfg)
        assert result_at_floor == result_below

    def test_freshness_zero_age(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        result = freshness(0.0, cfg)
        assert result > 0.5  # Should use age_floor

    def test_freshness_different_slope(self):
        cfg1 = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        cfg2 = {"a50_days": 7.0, "slope": 2.0, "age_floor_days": 0.25}
        
        # Steeper slope (larger value) = more gradual transition
        # At young age (1 day), steeper slope gives LOWER freshness (less steep drop from 1.0)
        young = freshness(1.0, cfg1)
        young_steep = freshness(1.0, cfg2)
        assert young_steep < young  # Steeper = lower for young items
        
        # At old age (30 days), steeper slope gives HIGHER freshness (more gradual)
        old = freshness(30.0, cfg1)
        old_steep = freshness(30.0, cfg2)
        assert old_steep > old  # Steeper = higher for old items


class TestPenalty:
    """Tests for _penalty function."""

    def test_penalty_no_shows_no_rejects(self):
        item = {"times_shown": 0, "rejected": 0}
        cfg = {"shown_decay": 0.05, "rejected_decay": 0.3}
        result = _penalty(item, cfg)
        assert result == 1.0

    def test_penalty_with_shows(self):
        item = {"times_shown": 2, "rejected": 0}
        cfg = {"shown_decay": 0.05, "rejected_decay": 0.3}
        result = _penalty(item, cfg)
        assert result == (0.05 ** 2)

    def test_penalty_with_rejects(self):
        item = {"times_shown": 0, "rejected": 3}
        cfg = {"shown_decay": 0.05, "rejected_decay": 0.3}
        result = _penalty(item, cfg)
        assert result == (0.3 ** 3)

    def test_penalty_both(self):
        item = {"times_shown": 1, "rejected": 2}
        cfg = {"shown_decay": 0.5, "rejected_decay": 0.5}
        result = _penalty(item, cfg)
        assert result == 0.5 * 0.25  # 0.125

    def test_penalty_missing_keys(self):
        item = {}
        cfg = {"shown_decay": 0.5, "rejected_decay": 0.5}
        result = _penalty(item, cfg)
        assert result == 1.0  # defaults to 0


class TestGreedyScore:
    """Tests for greedy_score function."""

    def test_greedy_score_basic(self):
        item = {
            "rel": 0.9,
            "age_days": 1.0,
            "times_shown": 0,
            "rejected": 0,
        }
        cfg = {
            "a50_days": 7.0,
            "slope": 1.0,
            "age_floor_days": 0.25,
            "shown_decay": 0.05,
            "rejected_decay": 0.3,
        }
        result = greedy_score(item, cfg)
        
        expected_freshness = freshness(1.0, cfg)
        expected = 0.9 * expected_freshness * 1.0
        assert abs(result - expected) < 0.001

    def test_greedy_score_with_penalties(self):
        item = {"rel": 1.0, "age_days": 7.0, "times_shown": 1, "rejected": 1}
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "shown_decay": 0.5, "rejected_decay": 0.5}
        result = greedy_score(item, cfg)
        
        expected = 1.0 * 0.5 * 0.5 * 0.5  # rel * freshness(7) * shown_decay * rejected_decay
        assert abs(result - expected) < 0.001

    def test_greedy_score_zero_rel(self):
        item = {"rel": 0.0, "age_days": 1.0}
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "shown_decay": 0.05, "rejected_decay": 0.3}
        result = greedy_score(item, cfg)
        assert result == 0.0


class TestExploreWeight:
    """Tests for explore_weight function."""

    def test_explore_weight_flattens_freshness(self):
        item = {"rel": 1.0, "age_days": 30.0, "times_shown": 0, "rejected": 0}
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "explore_gamma": 0.5, "shown_decay": 0.05, "rejected_decay": 0.3}
        
        greedy = greedy_score(item, cfg)
        explore = explore_weight(item, cfg)
        
        # Explore weight should be higher for old items (flatter curve)
        # At age 30, freshness is low, but freshness^0.5 is higher
        assert explore > greedy

    def test_explore_weight_gamma_zero(self):
        item = {"rel": 1.0, "age_days": 30.0, "times_shown": 0, "rejected": 0}
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "explore_gamma": 0.0, "shown_decay": 0.05, "rejected_decay": 0.3}
        
        explore = explore_weight(item, cfg)
        # gamma=0 means freshness^0 = 1, so only rel * penalty
        expected = 1.0 * 1.0 * 1.0
        assert abs(explore - expected) < 0.001

    def test_explore_weight_gamma_one(self):
        item = {"rel": 1.0, "age_days": 30.0, "times_shown": 0, "rejected": 0}
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "explore_gamma": 1.0, "shown_decay": 0.05, "rejected_decay": 0.3}
        
        explore = explore_weight(item, cfg)
        greedy = greedy_score(item, cfg)
        assert abs(explore - greedy) < 0.001


class TestDraw:
    """Tests for _draw function."""

    def test_draw_greedy_when_epsilon_zero(self):
        pool = [
            {"id": "1", "rel": 0.9, "age_days": 1.0},
            {"id": "2", "rel": 0.5, "age_days": 10.0},
        ]
        cfg = {"epsilon": 0.0, "a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "shown_decay": 0.05, "rejected_decay": 0.3, "explore_gamma": 0.3}
        rng = Mock()
        rng.random.return_value = 0.5  # > epsilon
        
        item, mode = _draw(pool, cfg, rng)
        
        assert item["id"] == "1"  # Higher greedy score
        assert mode == "greedy"

    def test_draw_explore_when_epsilon_one(self):
        pool = [
            {"id": "1", "rel": 0.9, "age_days": 1.0},
            {"id": "2", "rel": 0.5, "age_days": 10.0},
        ]
        cfg = {"epsilon": 1.0, "a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "shown_decay": 0.05, "rejected_decay": 0.3, "explore_gamma": 0.3}
        rng = Mock()
        rng.random.return_value = 0.5  # < epsilon
        rng.choices.return_value = [pool[1]]  # Pick second item
        
        item, mode = _draw(pool, cfg, rng)
        
        assert item["id"] == "2"
        assert mode == "explore"
        rng.choices.assert_called_once()

    def test_draw_empty_pool_raises(self):
        pool = []
        cfg = {"epsilon": 0.25, "a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "shown_decay": 0.05, "rejected_decay": 0.3, "explore_gamma": 0.3}
        rng = Mock()
        rng.random.return_value = 0.5
        
        with pytest.raises(ValueError):
            _draw(pool, cfg, rng)

    def test_draw_explore_weights_used(self):
        pool = [
            {"id": "1", "rel": 0.9, "age_days": 1.0, "times_shown": 0, "rejected": 0},
            {"id": "2", "rel": 0.5, "age_days": 30.0, "times_shown": 0, "rejected": 0},
        ]
        cfg = {"epsilon": 1.0, "a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25,
               "shown_decay": 0.05, "rejected_decay": 0.3, "explore_gamma": 0.3}
        rng = Mock()
        rng.random.return_value = 0.1  # < epsilon
        rng.choices.return_value = [pool[0]]
        
        _draw(pool, cfg, rng)
        
        # Verify choices was called with explore weights
        args, kwargs = rng.choices.call_args
        weights = kwargs.get("weights", args[1] if len(args) > 1 else [])
        assert len(weights) == 2
        # The weights should be explore_weight for each item
        # Just verify it was called with some weights
        assert all(w >= 0 for w in weights)


class TestPickDesk:
    """Tests for pick_desk function."""

    @pytest.fixture
    def sample_candidates(self):
        return [
            {"id": "1", "rel": 0.9, "age_days": 1.0, "subtopic": "ml", "source_type": "researchlike", "times_shown": 0, "rejected": 0},
            {"id": "2", "rel": 0.8, "age_days": 2.0, "subtopic": "ml", "source_type": "researchlike", "times_shown": 1, "rejected": 0},
            {"id": "3", "rel": 0.7, "age_days": 0.5, "subtopic": "physics", "source_type": "newslike", "times_shown": 0, "rejected": 0},
            {"id": "4", "rel": 0.6, "age_days": 5.0, "subtopic": "physics", "source_type": "commentary", "times_shown": 0, "rejected": 0},
            {"id": "5", "rel": 0.5, "age_days": 10.0, "subtopic": "cs", "source_type": "researchlike", "times_shown": 0, "rejected": 0},
            {"id": "6", "rel": 0.4, "age_days": 20.0, "subtopic": "cs", "source_type": "newslike", "times_shown": 0, "rejected": 0},
        ]

    @pytest.fixture
    def basic_cfg(self):
        return {
            "epsilon": 0.0,  # Deterministic greedy
            "a50_days": 7.0,
            "slope": 1.0,
            "age_floor_days": 0.25,
            "explore_gamma": 0.3,
            "shown_decay": 0.05,
            "rejected_decay": 0.3,
            "skip_exhausted_subtopics": True,
        }

    def test_pick_desk_basic(self, sample_candidates, basic_cfg):
        rng = Mock()
        rng.random.return_value = 0.5
        rng.choices.return_value = [sample_candidates[0]]
        
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 3, basic_cfg, rng)
        
        assert len(picks) <= 3
        assert all(isinstance(p, tuple) and len(p) == 2 for p in picks)
        assert all(p[1] in ("greedy", "explore") for p in picks)

    def test_pick_desk_respects_n(self, sample_candidates, basic_cfg):
        rng = Mock()
        rng.random.return_value = 0.5
        # Always return first available
        def choices_side_effect(population, weights=None, k=1):
            return [population[0]]
        rng.choices.side_effect = choices_side_effect
        
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 2, basic_cfg, rng)
        
        assert len(picks) == 2

    def test_pick_desk_subtopic_balance(self, sample_candidates, basic_cfg):
        """Should pick from subtopic with fewest picks first."""
        rng = Mock()
        rng.random.return_value = 0.5
        rng.choices.return_value = [sample_candidates[0]]
        
        # With epsilon=0, always greedy, should balance subtopics
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 3, basic_cfg, rng)
        
        # Should have picked from different subtopics
        subtopics = [p[0]["subtopic"] for p in picks]
        assert len(set(subtopics)) == min(3, len(picks))  # All different if possible

    def test_pick_desk_minimum_types(self, sample_candidates, basic_cfg):
        """Should satisfy minimum source_type requirements."""
        cfg = {**basic_cfg, "epsilon": 0.0}
        rng = Mock()
        rng.random.return_value = 0.5
        rng.choices.return_value = [sample_candidates[0]]
        
        # Require at least 1 newslike
        minimum_types = {"newslike": 1}
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 3, cfg, rng, minimum_types)
        
        # At least one newslike should be picked
        source_types = [p[0].get("source_type") for p in picks]
        assert "newslike" in source_types

    def test_pick_desk_skip_exhausted(self, sample_candidates, basic_cfg):
        """Should skip subtopics where all items have been shown."""
        # Make all ml items shown
        for c in sample_candidates:
            if c["subtopic"] == "ml":
                c["times_shown"] = 5
        
        cfg = {**basic_cfg, "epsilon": 0.0, "skip_exhausted_subtopics": True}
        rng = Mock()
        rng.random.return_value = 0.5
        rng.choices.return_value = [sample_candidates[2]]  # physics item
        
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 2, cfg, rng)
        
        # Should not pick from ml (all exhausted)
        subtopics = [p[0]["subtopic"] for p in picks]
        assert "ml" not in subtopics

    def test_pick_desk_fallback_when_all_exhausted(self, sample_candidates, basic_cfg):
        """Should fall back to exhausted subtopics if all are exhausted."""
        for c in sample_candidates:
            c["times_shown"] = 5
        
        cfg = {**basic_cfg, "epsilon": 0.0, "skip_exhausted_subtopics": True}
        rng = Mock()
        rng.random.return_value = 0.5
        rng.choices.return_value = [sample_candidates[0]]
        
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 2, cfg, rng)
        
        # Should still pick something (fallback)
        assert len(picks) > 0

    def test_pick_desk_no_skip_exhausted(self, sample_candidates, basic_cfg):
        """When skip_exhausted=False, should pick from exhausted subtopics."""
        for c in sample_candidates:
            c["times_shown"] = 5
        
        cfg = {**basic_cfg, "epsilon": 0.0, "skip_exhausted_subtopics": False}
        rng = Mock()
        rng.random.return_value = 0.5
        rng.choices.return_value = [sample_candidates[0]]
        
        picks = pick_desk(sample_candidates, ["ml", "physics", "cs"], 2, cfg, rng)
        
        # Can pick from any subtopic
        assert len(picks) > 0

    def test_pick_desk_empty_candidates(self, basic_cfg):
        rng = Mock()
        picks = pick_desk([], ["ml", "physics"], 5, basic_cfg, rng)
        assert picks == []

    def test_pick_desk_no_matching_subtopics(self, sample_candidates, basic_cfg):
        rng = Mock()
        picks = pick_desk(sample_candidates, ["nonexistent"], 5, basic_cfg, rng)
        assert picks == []


class TestPickReserves:
    """Tests for pick_reserves function."""

    @pytest.fixture
    def sample_pool(self):
        return [
            {"id": "1", "rel": 0.9, "age_days": 1.0, "source_type": "researchlike", "times_shown": 0, "rejected": 0},
            {"id": "2", "rel": 0.8, "age_days": 2.0, "source_type": "researchlike", "times_shown": 0, "rejected": 0},
            {"id": "3", "rel": 0.7, "age_days": 0.5, "source_type": "newslike", "times_shown": 0, "rejected": 0},
            {"id": "4", "rel": 0.6, "age_days": 5.0, "source_type": "commentary", "times_shown": 0, "rejected": 0},
            {"id": "5", "rel": 0.5, "age_days": 10.0, "source_type": "researchlike", "times_shown": 0, "rejected": 0},
        ]

    @pytest.fixture
    def basic_cfg(self):
        return {
            "a50_days": 7.0,
            "slope": 1.0,
            "age_floor_days": 0.25,
            "shown_decay": 0.05,
            "rejected_decay": 0.3,
        }

    def test_pick_reserves_basic(self, sample_pool, basic_cfg):
        taken = {"1", "2"}
        reserves = pick_reserves(sample_pool, taken, 3, basic_cfg)
        
        assert len(reserves) == 3
        # Should not include taken items
        reserve_ids = {r["id"] for r in reserves}
        assert reserve_ids.isdisjoint(taken)

    def test_pick_reserves_sorted_by_greedy_score(self, sample_pool, basic_cfg):
        taken = set()
        reserves = pick_reserves(sample_pool, taken, 5, basic_cfg)
        
        # Should be sorted by greedy score descending
        scores = [greedy_score(r, basic_cfg) for r in reserves]
        assert scores == sorted(scores, reverse=True)

    def test_pick_reserves_minimum_types(self, sample_pool, basic_cfg):
        taken = set()
        minimum_types = {"commentary": 1, "newslike": 1}
        
        reserves = pick_reserves(sample_pool, taken, 3, basic_cfg, minimum_types)
        
        reserve_types = {r.get("source_type") for r in reserves}
        assert "commentary" in reserve_types
        assert "newslike" in reserve_types

    def test_pick_reserves_minimum_types_respected_first(self, sample_pool, basic_cfg):
        """Minimum type items should appear first in reserves."""
        taken = set()
        minimum_types = {"commentary": 1}
        
        reserves = pick_reserves(sample_pool, taken, 3, basic_cfg, minimum_types)
        
        # First item should be commentary
        assert reserves[0]["source_type"] == "commentary"

    def test_pick_reserves_limit_k(self, sample_pool, basic_cfg):
        taken = set()
        reserves = pick_reserves(sample_pool, taken, 2, basic_cfg)
        
        assert len(reserves) == 2

    def test_pick_reserves_more_than_available(self, sample_pool, basic_cfg):
        taken = set()
        reserves = pick_reserves(sample_pool, taken, 10, basic_cfg)
        
        assert len(reserves) == 5  # Only 5 available

    def test_pick_reserves_empty_pool(self, basic_cfg):
        reserves = pick_reserves([], set(), 5, basic_cfg)
        assert reserves == []


class TestKeywordEngine:
    """Tests for KeywordEngine class."""

    @pytest.fixture
    def sample_pool(self):
        return [
            {"id": f"item_{i}", "title": f"Title {i}", "rel": 0.9 - i*0.1, 
             "age_days": float(i), "subtopic": ["ml", "physics", "cs", "bio", "math"][i % 5],
             "source_type": ["researchlike", "newslike", "commentary"][i % 3],
             "times_shown": 0, "rejected": 0, "authors": []}
            for i in range(20)
        ]

    @pytest.fixture
    def engine(self):
        return KeywordEngine()

    def test_engine_name(self, engine):
        assert engine.name == "keyword"

    def test_engine_description(self, engine):
        assert "Keyword" in engine.description
        assert "epsilon-greedy" in engine.description

    def test_engine_select_basic(self, engine, sample_pool):
        result = engine.select(sample_pool, {}, seed=42)
        
        assert "primary" in result
        assert "science" in result
        assert "reserve" in result
        
        # Check structure
        for desk in ["primary", "science", "reserve"]:
            for item in result[desk]:
                assert "id" in item
                assert "mode" in item
                assert "desk" in item
                assert item["mode"] in ("greedy", "explore", "reserve")
                assert item["desk"] == desk

    def test_engine_select_respects_slots(self, engine):
        # Need pool with matching subtopics from default desk_config
        primary_subtopics = ["dse", "accel", "fab"]
        science_subtopics = ["gr", "qft", "condmat", "neuro"]
        all_subtopics = primary_subtopics + science_subtopics
        
        pool = [
            {"id": f"item_{i}", "title": f"Title {i}", "rel": 0.9 - i*0.01, 
             "age_days": float(i), "subtopic": all_subtopics[i % len(all_subtopics)],
             "source_type": ["researchlike", "newslike", "commentary"][i % 3],
             "times_shown": 0, "rejected": 0, "authors": []}
            for i in range(20)
        ]
        config = {"primary_slots": 3, "science_slots": 2, "reserve_slots": 10}
        result = engine.select(pool, config, seed=42)
        
        assert len(result["primary"]) == 3
        assert len(result["science"]) == 2
        assert len(result["reserve"]) == 10

    def test_engine_select_deterministic(self, engine, sample_pool):
        result1 = engine.select(sample_pool, {}, seed=123)
        result2 = engine.select(sample_pool, {}, seed=123)
        
        # Same seed should give same results
        for desk in ["primary", "science", "reserve"]:
            ids1 = [i["id"] for i in result1[desk]]
            ids2 = [i["id"] for i in result2[desk]]
            assert ids1 == ids2

    def test_engine_select_different_seeds(self, engine):
        # Use pool with default desk_config subtopics
        primary_subtopics = ["dse", "accel", "fab"]
        science_subtopics = ["gr", "qft", "condmat", "neuro"]
        all_subtopics = primary_subtopics + science_subtopics
        
        pool = [
            {"id": f"item_{i}", "title": f"Title {i}", "rel": 0.9 - i*0.01, 
             "age_days": float(i), "subtopic": all_subtopics[i % len(all_subtopics)],
             "source_type": ["researchlike", "newslike", "commentary"][i % 3],
             "times_shown": 0, "rejected": 0, "authors": []}
            for i in range(50)
        ]
        result1 = engine.select(pool, {}, seed=1)
        result2 = engine.select(pool, {}, seed=2)
        
        # Different seeds should (likely) give different results
        ids1 = set(i["id"] for desk in result1.values() for i in desk)
        ids2 = set(i["id"] for desk in result2.values() for i in desk)
        # Not guaranteed but very likely with larger pool
        assert ids1 != ids2

    def test_engine_config_override(self, engine, sample_pool):
        # Override epsilon to 0 (pure greedy)
        config = {"epsilon": 0.0}
        result = engine.select(sample_pool, config, seed=42)
        
        # All picks should be greedy (except reserves)
        for desk in ["primary", "science"]:
            for item in result[desk]:
                assert item["mode"] == "greedy"
        
        # Reserves are always "reserve" mode
        for item in result["reserve"]:
            assert item["mode"] == "reserve"

    def test_engine_minimum_types(self, engine):
        # Pool with matching subtopics from default desk_config and source types
        primary_subtopics = ["dse", "accel", "fab"]
        science_subtopics = ["gr", "qft", "condmat", "neuro"]
        all_subtopics = primary_subtopics + science_subtopics
        
        pool = [
            {"id": f"item_{i}", "title": f"Title {i}", "rel": 0.9 - i*0.01, 
             "age_days": float(i), "subtopic": all_subtopics[i % len(all_subtopics)],
             "source_type": ["researchlike", "newslike", "commentary"][i % 3],
             "times_shown": 0, "rejected": 0, "authors": []}
            for i in range(30)
        ]
        config = {
            "primary_min_types": {"researchlike": 2, "newslike": 1},
            "science_min_types": {"newslike": 1},
            "primary_slots": 5,
            "science_slots": 5,
            "reserve_slots": 10,
        }
        result = engine.select(pool, config, seed=42)
        
        primary_types = [i.get("source_type") for i in result["primary"]]
        science_types = [i.get("source_type") for i in result["science"]]
        
        assert primary_types.count("researchlike") >= 2
        assert primary_types.count("newslike") >= 1
        assert science_types.count("newslike") >= 1

    def test_engine_no_duplicate_across_desks(self, engine, sample_pool):
        result = engine.select(sample_pool, {}, seed=42)
        
        primary_ids = {i["id"] for i in result["primary"]}
        science_ids = {i["id"] for i in result["science"]}
        reserve_ids = {i["id"] for i in result["reserve"]}
        
        # No overlap between desks
        assert primary_ids.isdisjoint(science_ids)
        assert primary_ids.isdisjoint(reserve_ids)
        assert science_ids.isdisjoint(reserve_ids)

    def test_engine_desk_config(self):
        custom_desks = {
            "primary": {"subtopics": ["a", "b"], "title": "Custom 1"},
            "science": {"subtopics": ["c", "d"], "title": "Custom 2"},
        }
        engine = KeywordEngine(desk_config=custom_desks)
        
        pool = [
            {"id": "1", "rel": 0.9, "age_days": 1.0, "subtopic": "a", "source_type": "researchlike", "times_shown": 0, "rejected": 0},
            {"id": "2", "rel": 0.8, "age_days": 2.0, "subtopic": "c", "source_type": "newslike", "times_shown": 0, "rejected": 0},
        ]
        
        result = engine.select(pool, {"primary_slots": 1, "science_slots": 1, "reserve_slots": 0}, seed=42)
        
        assert "primary" in result
        assert "science" in result
        assert len(result["primary"]) == 1
        assert len(result["science"]) == 1

    def test_run_keyword_selection_standalone(self, sample_pool):
        """Test the backward-compatible standalone function."""
        result = run_keyword_selection(sample_pool, {"epsilon": 0.0}, seed=42)
        
        assert "primary" in result
        assert "science" in result
        assert "reserve" in result


class TestKeywordEngineEdgeCases:
    """Edge case tests."""

    def test_empty_pool(self):
        engine = KeywordEngine()
        result = engine.select([], {}, seed=42)
        
        assert result["primary"] == []
        assert result["science"] == []
        assert result["reserve"] == []

    def test_pool_smaller_than_slots(self):
        engine = KeywordEngine()
        pool = [
            {"id": "1", "rel": 0.9, "age_days": 1.0, "subtopic": "ml", "source_type": "researchlike", "times_shown": 0, "rejected": 0},
        ]
        result = engine.select(pool, {"primary_slots": 5, "science_slots": 5, "reserve_slots": 10}, seed=42)
        
        assert len(result["primary"]) <= 1
        assert len(result["science"]) == 0
        # Reserve can still pick from the pool if not taken
        assert len(result["reserve"]) <= 1

    def test_all_items_same_subtopic(self):
        engine = KeywordEngine()
        # Use a subtopic from default primary desk_config
        pool = [
            {"id": f"item_{i}", "rel": 0.9, "age_days": 1.0, "subtopic": "dse", "source_type": "researchlike", "times_shown": 0, "rejected": 0}
            for i in range(5)
        ]
        result = engine.select(pool, {"primary_slots": 3, "science_slots": 3, "reserve_slots": 5}, seed=42)
        
        # All items have subtopic "dse" which is in primary but not science
        # So primary gets items, science gets none
        assert len(result["primary"]) == 3
        assert len(result["science"]) == 0

    def test_config_merge(self, sample_pool):
        """Instance config should be merged with runtime config."""
        engine = KeywordEngine(config={"epsilon": 0.1, "a50_days": 14.0})
        result = engine.select(sample_pool, {"epsilon": 0.5}, seed=42)
        
        # Runtime config should override instance config
        # Hard to test directly but should not crash
        assert "primary" in result

    def test_item_mode_field_added(self, sample_pool):
        engine = KeywordEngine()
        result = engine.select(sample_pool, {}, seed=42)
        
        for desk_items in result.values():
            for item in desk_items:
                assert "mode" in item
                assert item["mode"] in ("greedy", "explore", "reserve")

    def test_item_desk_field_added(self, sample_pool):
        engine = KeywordEngine()
        result = engine.select(sample_pool, {}, seed=42)
        
        for desk_name, desk_items in result.items():
            for item in desk_items:
                assert "desk" in item
                assert item["desk"] == desk_name