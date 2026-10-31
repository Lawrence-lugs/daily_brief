"""Tests for MetricsCollector class."""
from __future__ import annotations
import pytest
import math
from simulate.core.metrics import MetricsCollector


class TestJaccard:
    """Tests for jaccard similarity coefficient."""

    def test_jaccard_basic(self):
        set_a = {1, 2, 3}
        set_b = {2, 3, 4}
        assert MetricsCollector.jaccard(set_a, set_b) == 2 / 4  # 0.5

    def test_jaccard_identical(self):
        set_a = {1, 2, 3}
        set_b = {1, 2, 3}
        assert MetricsCollector.jaccard(set_a, set_b) == 1.0

    def test_jaccard_disjoint(self):
        set_a = {1, 2, 3}
        set_b = {4, 5, 6}
        assert MetricsCollector.jaccard(set_a, set_b) == 0.0

    def test_jaccard_empty_union(self):
        set_a = set()
        set_b = set()
        assert MetricsCollector.jaccard(set_a, set_b) == 0.0

    def test_jaccard_one_empty(self):
        set_a = {1, 2, 3}
        set_b = set()
        assert MetricsCollector.jaccard(set_a, set_b) == 0.0

    def test_jaccard_string_elements(self):
        set_a = {"a", "b", "c"}
        set_b = {"b", "c", "d"}
        assert MetricsCollector.jaccard(set_a, set_b) == 2 / 4


class TestOverlap:
    """Tests for detailed overlap analysis."""

    def test_overlap_basic(self):
        set_a = {1, 2, 3}
        set_b = {2, 3, 4}
        result = MetricsCollector.overlap(set_a, set_b)
        
        assert result["jaccard"] == 0.5
        assert result["intersection"] == 2
        assert result["union"] == 4
        assert result["only_a"] == 1
        assert result["only_b"] == 1
        assert set(result["intersection_ids"]) == {2, 3}
        assert set(result["only_a_ids"]) == {1}
        assert set(result["only_b_ids"]) == {4}

    def test_overlap_identical(self):
        set_a = {1, 2, 3}
        set_b = {1, 2, 3}
        result = MetricsCollector.overlap(set_a, set_b)
        
        assert result["jaccard"] == 1.0
        assert result["intersection"] == 3
        assert result["union"] == 3
        assert result["only_a"] == 0
        assert result["only_b"] == 0

    def test_overlap_empty(self):
        set_a = set()
        set_b = set()
        result = MetricsCollector.overlap(set_a, set_b)
        
        assert result["jaccard"] == 0.0
        assert result["intersection"] == 0
        assert result["union"] == 0
        assert result["only_a"] == 0
        assert result["only_b"] == 0


class TestDiversity:
    """Tests for diversity (categorical distribution)."""

    def test_diversity_basic(self):
        items = [
            {"source_type": "researchlike"},
            {"source_type": "researchlike"},
            {"source_type": "newslike"},
            {"source_type": "commentary"},
            {"source_type": None},
            {},  # missing key
        ]
        result = MetricsCollector.diversity(items, "source_type")
        assert result == {"researchlike": 2, "newslike": 1, "commentary": 1}

    def test_diversity_all_none(self):
        items = [{"source_type": None}, {}, {"source_type": None}]
        result = MetricsCollector.diversity(items, "source_type")
        assert result == {}

    def test_diversity_empty_list(self):
        items = []
        result = MetricsCollector.diversity(items, "source_type")
        assert result == {}

    def test_diversity_different_key(self):
        items = [
            {"subtopic": "ml"},
            {"subtopic": "ml"},
            {"subtopic": "physics"},
        ]
        result = MetricsCollector.diversity(items, "subtopic")
        assert result == {"ml": 2, "physics": 1}


class TestFreshness:
    """Tests for freshness statistics."""

    def test_freshness_basic(self):
        items = [
            {"age_days": 1.0},
            {"age_days": 2.0},
            {"age_days": 3.0},
            {"age_days": 4.0},
        ]
        result = MetricsCollector.freshness(items)
        
        assert result["mean"] == 2.5
        assert result["median"] == 2.5
        assert result["min"] == 1.0
        assert result["max"] == 4.0
        assert result["count"] == 4

    def test_freshness_odd_count(self):
        items = [{"age_days": 1.0}, {"age_days": 2.0}, {"age_days": 3.0}]
        result = MetricsCollector.freshness(items)
        
        assert result["median"] == 2.0

    def test_freshness_empty(self):
        items = []
        result = MetricsCollector.freshness(items)
        
        assert result == {"mean": 0, "median": 0, "min": 0, "max": 0, "count": 0}

    def test_freshness_none_values(self):
        items = [
            {"age_days": 1.0},
            {"age_days": None},
            {"age_days": 3.0},
            {},  # missing key
        ]
        result = MetricsCollector.freshness(items)
        
        assert result["mean"] == 2.0
        assert result["count"] == 2

    def test_freshness_single_item(self):
        items = [{"age_days": 5.0}]
        result = MetricsCollector.freshness(items)
        
        assert result["mean"] == 5.0
        assert result["median"] == 5.0
        assert result["min"] == 5.0
        assert result["max"] == 5.0
        assert result["count"] == 1


class TestCoverage:
    """Tests for coverage metric."""

    def test_coverage_basic(self):
        all_items = [{"id": "1"}, {"id": "2"}, {"id": "3"}, {"id": "4"}]
        picked_items = [{"id": "1"}, {"id": "3"}]
        assert MetricsCollector.coverage(all_items, picked_items) == 0.5

    def test_coverage_full(self):
        all_items = [{"id": "1"}, {"id": "2"}]
        picked_items = [{"id": "1"}, {"id": "2"}]
        assert MetricsCollector.coverage(all_items, picked_items) == 1.0

    def test_coverage_zero(self):
        all_items = [{"id": "1"}, {"id": "2"}]
        picked_items = []
        assert MetricsCollector.coverage(all_items, picked_items) == 0.0

    def test_coverage_empty_pool(self):
        all_items = []
        picked_items = [{"id": "1"}]
        assert MetricsCollector.coverage(all_items, picked_items) == 0.0


class TestModeDistribution:
    """Tests for mode distribution."""

    def test_mode_distribution_basic(self):
        items = [
            {"mode": "greedy"},
            {"mode": "greedy"},
            {"mode": "explore"},
            {"mode": "reserve"},
            {"mode": "greedy"},
        ]
        result = MetricsCollector.mode_distribution(items)
        assert result == {"greedy": 3, "explore": 1, "reserve": 1}

    def test_mode_distribution_missing_mode(self):
        items = [
            {"mode": "greedy"},
            {},  # missing mode
            {"mode": "explore"},
        ]
        result = MetricsCollector.mode_distribution(items)
        assert result == {"greedy": 1, "explore": 1, "unknown": 1}

    def test_mode_distribution_empty(self):
        items = []
        result = MetricsCollector.mode_distribution(items)
        assert result == {}


class TestFreshnessCurve:
    """Tests for keyword engine freshness curve."""

    def test_freshness_curve_at_a50(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        # At a50_days, freshness should be 0.5 (sigmoid(0) = 0.5)
        result = MetricsCollector.freshness_curve(7.0, cfg)
        assert abs(result - 0.5) < 0.001

    def test_freshness_curve_young(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        # Very young item should have high freshness
        result = MetricsCollector.freshness_curve(0.5, cfg)
        assert result > 0.5

    def test_freshness_curve_old(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        # Old item should have low freshness
        result = MetricsCollector.freshness_curve(100.0, cfg)
        assert result < 0.5

    def test_freshness_curve_age_floor(self):
        cfg = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 1.0}
        # Age below floor should be clamped to floor
        result_floor = MetricsCollector.freshness_curve(1.0, cfg)
        result_below = MetricsCollector.freshness_curve(0.1, cfg)
        assert result_floor == result_below

    def test_freshness_curve_different_params(self):
        cfg1 = {"a50_days": 7.0, "slope": 1.0, "age_floor_days": 0.25}
        cfg2 = {"a50_days": 14.0, "slope": 2.0, "age_floor_days": 0.25}
        
        result1 = MetricsCollector.freshness_curve(7.0, cfg1)
        result2 = MetricsCollector.freshness_curve(7.0, cfg2)
        
        # Different params should give different results
        assert result1 != result2


class TestLRFreshnessCurve:
    """Tests for LR engine freshness curve."""

    def test_lr_freshness_curve_logistic_at_halflife(self):
        cfg = {"halfLifeDays": 7, "freshness": {"model": "logistic", "steepness": math.log(4)}}
        # At half-life, freshness should be 0.5
        result = MetricsCollector.lr_freshness_curve(7.0, cfg)
        assert abs(result - 0.5) < 0.001

    def test_lr_freshness_curve_logistic_young(self):
        cfg = {"halfLifeDays": 7, "freshness": {"model": "logistic", "steepness": math.log(4)}}
        result = MetricsCollector.lr_freshness_curve(0.5, cfg)
        assert result > 0.5

    def test_lr_freshness_curve_logistic_old(self):
        cfg = {"halfLifeDays": 7, "freshness": {"model": "logistic", "steepness": math.log(4)}}
        result = MetricsCollector.lr_freshness_curve(100.0, cfg)
        assert result < 0.5

    def test_lr_freshness_curve_exponential(self):
        cfg = {"halfLifeDays": 7, "freshness": {"model": "exponential"}}
        # At half-life, exponential should be 0.5
        result = MetricsCollector.lr_freshness_curve(7.0, cfg)
        assert abs(result - 0.5) < 0.001

    def test_lr_freshness_curve_exponential_decay(self):
        cfg = {"halfLifeDays": 7, "freshness": {"model": "exponential"}}
        # After 2 half-lives, should be 0.25
        result = MetricsCollector.lr_freshness_curve(14.0, cfg)
        assert abs(result - 0.25) < 0.001

    def test_lr_freshness_curve_negative_age(self):
        cfg = {"halfLifeDays": 7, "freshness": {"model": "logistic"}}
        result = MetricsCollector.lr_freshness_curve(-5.0, cfg)
        # Negative age should be clamped to 0
        result_zero = MetricsCollector.lr_freshness_curve(0.0, cfg)
        assert result == result_zero


class TestFreshnessConfigSummary:
    """Tests for freshness_config_summary."""

    def test_freshness_config_summary_nested(self, sample_raw_config):
        result = MetricsCollector.freshness_config_summary(sample_raw_config)
        
        assert "lr_freshness" in result
        assert "keyword_freshness" in result
        
        lr = result["lr_freshness"]
        assert lr["model"] == "logistic"
        assert lr["halfLifeDays"] == 7
        assert lr["steepness"] == math.log(4)
        assert lr["epsilon"] == 0.25
        assert lr["explore"]["gamma"] == 0.5
        assert lr["explore"]["floor"] == 0.01
        assert lr["dedupe"]["t0"] == 7
        assert lr["dedupe"]["scale"] == 2
        assert lr["dedupe"]["hardWindowDays"] == 2
        
        kw = result["keyword_freshness"]
        assert kw["model"] == "logistic_in_log_age"
        assert kw["a50_days"] == 7.0
        assert kw["slope"] == 1.0
        assert kw["age_floor_days"] == 0.25
        assert kw["epsilon"] == 0.25
        assert kw["explore_gamma"] == 0.3
        assert kw["shown_decay"] == 0.05
        assert kw["rejected_decay"] == 0.3
        
        # Check reference ages are present
        for age in [0, 1, 7, 30, 50, 120]:
            assert str(age) in lr["freshness_at_ages"]
            assert str(age) in kw["freshness_at_ages"]

    def test_freshness_config_summary_flat(self, flat_config):
        result = MetricsCollector.freshness_config_summary(flat_config)
        
        assert "lr_freshness" in result
        assert "keyword_freshness" in result
        
        # Should use defaults where not specified
        lr = result["lr_freshness"]
        assert lr["model"] == "logistic"
        assert lr["halfLifeDays"] == 7
        assert lr["epsilon"] == 0.25
        
        kw = result["keyword_freshness"]
        assert kw["a50_days"] == 7.0
        assert kw["explore_gamma"] == 0.3

    def test_freshness_config_summary_empty(self):
        result = MetricsCollector.freshness_config_summary({})
        
        # Should use all defaults
        lr = result["lr_freshness"]
        assert lr["model"] == "logistic"
        assert lr["halfLifeDays"] == 7
        assert lr["epsilon"] == 0.25
        
        kw = result["keyword_freshness"]
        assert kw["a50_days"] == 7.0
        assert kw["slope"] == 1.0


class TestDeskStats:
    """Tests for desk_stats."""

    def test_desk_stats_basic(self, sample_selections):
        result = MetricsCollector.desk_stats(sample_selections)
        
        assert "primary" in result
        assert "science" in result
        assert "reserve" in result
        
        primary = result["primary"]
        assert primary["count"] == 5
        assert primary["source_types"] == {"researchlike": 3, "newslike": 1, "commentary": 1}
        assert primary["modes"] == {"greedy": 3, "explore": 2}
        assert "freshness" in primary
        assert primary["freshness"]["count"] == 5

    def test_desk_stats_empty(self):
        result = MetricsCollector.desk_stats({})
        assert result == {}

    def test_desk_stats_missing_fields(self):
        selections = {
            "primary": [
                {},  # missing all fields
                {"id": "1"},  # missing mode, age_days, source_type
            ]
        }
        result = MetricsCollector.desk_stats(selections)
        
        primary = result["primary"]
        assert primary["count"] == 2
        assert primary["modes"] == {"unknown": 2}
        assert primary["source_types"] == {}
        assert primary["freshness"]["count"] == 0


class TestCompareSelections:
    """Tests for compare_selections."""

    def test_compare_selections_basic(self):
        sel_a = {
            "primary": [
                {"id": "1", "age_days": 1.0, "source_type": "researchlike", "mode": "greedy"},
                {"id": "2", "age_days": 2.0, "source_type": "newslike", "mode": "explore"},
            ]
        }
        sel_b = {
            "primary": [
                {"id": "2", "age_days": 2.0, "source_type": "newslike", "mode": "greedy"},
                {"id": "3", "age_days": 3.0, "source_type": "commentary", "mode": "greedy"},
            ]
        }
        
        result = MetricsCollector.compare_selections(sel_a, sel_b, "primary")
        
        assert result["desk"] == "primary"
        assert result["overlap"]["jaccard"] == 1/3  # {2} / {1,2,3}
        assert result["overlap"]["intersection"] == 1
        assert result["overlap"]["union"] == 3
        
        assert result["source_types"]["a"] == {"researchlike": 1, "newslike": 1}
        assert result["source_types"]["b"] == {"newslike": 1, "commentary": 1}
        
        assert "freshness" in result
        assert "modes" in result

    def test_compare_selections_missing_desk(self):
        sel_a = {"primary": [{"id": "1"}]}
        sel_b = {"science": [{"id": "2"}]}
        
        result = MetricsCollector.compare_selections(sel_a, sel_b, "primary")
        
        # Should handle missing desk gracefully
        assert result["overlap"]["jaccard"] == 0.0
        assert result["source_types"]["a"] == {}
        assert result["source_types"]["b"] == {}

    def test_compare_selections_default_desk(self):
        sel_a = {"primary": [{"id": "1"}]}
        sel_b = {"primary": [{"id": "1"}]}
        
        result = MetricsCollector.compare_selections(sel_a, sel_b)  # default desk="primary"
        
        assert result["desk"] == "primary"
        assert result["overlap"]["jaccard"] == 1.0


class TestAggregateRuns:
    """Tests for aggregate_runs."""

    def test_aggregate_runs_basic(self, multiple_run_results):
        result = MetricsCollector.aggregate_runs(multiple_run_results, "primary")
        
        assert "keyword" in result
        assert "lr" in result
        
        kw = result["keyword"]
        assert kw["runs"] == 3
        assert kw["ever_picked"] > 0
        assert "consecutive_jaccard_mean" in kw
        assert "consecutive_jaccard_median" in kw
        assert "top_items" in kw
        assert "pick_frequency" in kw

    def test_aggregate_runs_empty(self):
        result = MetricsCollector.aggregate_runs([], "primary")
        assert result == {}

    def test_aggregate_runs_single_run(self, sample_run_result):
        result = MetricsCollector.aggregate_runs([sample_run_result], "primary")
        
        kw = result["keyword"]
        assert kw["runs"] == 1
        assert kw["consecutive_jaccard_mean"] == 0  # No consecutive pairs
        assert kw["consecutive_jaccard_median"] == 0

    def test_aggregate_runs_stability(self):
        # Same selections every run -> high stability
        runs = []
        for seed in [1, 2, 3]:
            runs.append({
                "seed": seed,
                "selections": {
                    "engine1": {"primary": [{"id": "1"}, {"id": "2"}]},
                    "engine2": {"primary": [{"id": "3"}, {"id": "4"}]},
                },
            })
        
        result = MetricsCollector.aggregate_runs(runs, "primary")
        
        # Consecutive Jaccard should be 1.0 (identical picks)
        assert result["engine1"]["consecutive_jaccard_mean"] == 1.0
        assert result["engine2"]["consecutive_jaccard_mean"] == 1.0


class TestEdgeCases:
    """Edge case and robustness tests."""

    def test_jaccard_with_none_elements(self):
        set_a = {1, 2, None}
        set_b = {2, None, 3}
        result = MetricsCollector.jaccard(set_a, set_b)
        assert result == 2 / 4  # {2, None} / {1, 2, 3, None}

    def test_diversity_with_unhashable_values(self):
        # Lists are unhashable - Counter will raise TypeError
        items = [{"tags": ["a", "b"]}, {"tags": ["c"]}]
        with pytest.raises(TypeError):
            MetricsCollector.diversity(items, "tags")

    def test_freshness_curve_zero_slope(self):
        cfg = {"a50_days": 7.0, "slope": 0.0, "age_floor_days": 0.25}
        # Zero slope would cause division by zero
        with pytest.raises(ZeroDivisionError):
            MetricsCollector.freshness_curve(7.0, cfg)

    def test_freshness_curve_negative_a50(self):
        cfg = {"a50_days": -7.0, "slope": 1.0, "age_floor_days": 0.25}
        # log of negative number
        with pytest.raises(ValueError):
            MetricsCollector.freshness_curve(7.0, cfg)

    def test_lr_freshness_curve_zero_half_life(self):
        cfg = {"halfLifeDays": 0, "freshness": {"model": "exponential"}}
        with pytest.raises(ZeroDivisionError):
            MetricsCollector.lr_freshness_curve(7.0, cfg)