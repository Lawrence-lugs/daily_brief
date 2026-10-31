"""Tests for config module."""
from __future__ import annotations
import pytest
import json
import tempfile
from pathlib import Path
from simulate.core.config import load_config, merge_config, freshness_config_summary


class TestLoadConfig:
    """Tests for load_config function."""

    def test_load_config_basic(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_data = {"key": "value", "number": 42, "nested": {"a": 1}}
        config_file.write_text(json.dumps(config_data))
        
        result = load_config(str(config_file))
        
        assert result == config_data

    def test_load_config_unicode(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_data = {"unicode": "日本語", "emoji": "🚀"}
        config_file.write_text(json.dumps(config_data, ensure_ascii=False), encoding="utf-8")
        
        result = load_config(str(config_file))
        
        assert result == config_data

    def test_load_config_missing_file(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_config(str(tmp_path / "nonexistent.json"))

    def test_load_config_invalid_json(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_file.write_text("not valid json")
        
        with pytest.raises(json.JSONDecodeError):
            load_config(str(config_file))


class TestMergeConfig:
    """Tests for merge_config function."""

    def test_merge_config_nested(self, sample_raw_config):
        result = merge_config(sample_raw_config, date="2026-10-30")
        
        # Should have date
        assert result["date"] == "2026-10-30"
        
        # Should have ranker, selection, sampling keys merged
        # ranker keys
        assert "sampling" in result  # from ranker
        # selection keys
        assert "a50_days" in result
        assert "slope" in result
        # sampling keys (should win conflicts)
        assert "epsilon" in result
        assert "halfLifeDays" in result

    def test_merge_config_flat(self, flat_config):
        result = merge_config(flat_config)
        
        assert result["date"] == "2026-10-29"
        # flat_config has keys at top level, merge_config adds date
        # The merge order is: ranker -> selection -> sampling
        # With no nested sections, result only has date from flat_config
        assert result["date"] == "2026-10-29"

    def test_merge_config_empty(self):
        result = merge_config({}, date="2026-10-29")
        
        assert result["date"] == "2026-10-29"
        # Should have minimal keys

    def test_merge_config_sampling_wins(self):
        """Sampling should win over selection for conflicting keys."""
        raw = {
            "selection": {"epsilon": 0.1},
            "ranker": {"sampling": {"epsilon": 0.3}},
        }
        result = merge_config(raw)
        
        assert result["epsilon"] == 0.3  # sampling wins

    def test_merge_config_date_override(self, sample_raw_config):
        result = merge_config(sample_raw_config, date="2026-12-25")
        
        assert result["date"] == "2026-12-25"

    def test_merge_config_date_from_raw(self):
        raw = {"date": "2026-01-01"}
        result = merge_config(raw)
        
        assert result["date"] == "2026-01-01"

    def test_merge_config_default_date(self):
        raw = {}
        result = merge_config(raw)
        
        assert result["date"] == "2026-10-29"  # default

    def test_merge_config_none_sections(self):
        raw = {
            "ranker": None,
            "selection": None,
        }
        result = merge_config(raw)
        
        assert "date" in result


class TestFreshnessConfigSummary:
    """Tests for freshness_config_summary function."""

    def test_freshness_config_summary_nested(self, sample_raw_config):
        result = freshness_config_summary(sample_raw_config)
        
        assert "lr_freshness" in result
        assert "keyword_freshness" in result
        
        lr = result["lr_freshness"]
        assert lr["model"] == "logistic"
        assert lr["halfLifeDays"] == 7
        assert lr["steepness"] == pytest.approx(1.386, rel=0.01)  # log(4)
        assert lr["epsilon"] == 0.25
        assert lr["explore"]["gamma"] == 0.5
        assert lr["explore"]["floor"] == 0.01
        assert lr["dedupe"]["t0"] == 7
        assert lr["dedupe"]["scale"] == 2
        assert lr["dedupe"]["hardWindowDays"] == 2
        # slots is in sampling.slots
        assert "slots" in lr
        
        kw = result["keyword_freshness"]
        assert kw["model"] == "logistic_in_log_age"
        assert kw["a50_days"] == 7.0
        assert kw["slope"] == 1.0
        assert kw["age_floor_days"] == 0.25
        assert kw["epsilon"] == 0.25
        assert kw["explore_gamma"] == 0.3
        assert kw["shown_decay"] == 0.05
        assert kw["rejected_decay"] == 0.3
        
        # Check reference ages
        for age in [0, 1, 7, 30, 50, 120]:
            assert str(age) in lr["freshness_at_ages"]
            assert str(age) in kw["freshness_at_ages"]
            # Values should be between 0 and 1
            assert 0 <= lr["freshness_at_ages"][str(age)] <= 1
            assert 0 <= kw["freshness_at_ages"][str(age)] <= 1

    def test_freshness_config_summary_flat(self, flat_config):
        result = freshness_config_summary(flat_config)
        
        assert "lr_freshness" in result
        assert "keyword_freshness" in result
        
        # Should use defaults for missing nested config
        lr = result["lr_freshness"]
        assert lr["model"] == "logistic"
        assert lr["halfLifeDays"] == 7
        assert lr["epsilon"] == 0.25
        
        kw = result["keyword_freshness"]
        assert kw["a50_days"] == 7.0
        assert kw["explore_gamma"] == 0.3

    def test_freshness_config_summary_empty(self):
        result = freshness_config_summary({})
        
        lr = result["lr_freshness"]
        assert lr["model"] == "logistic"
        assert lr["halfLifeDays"] == 7
        assert lr["epsilon"] == 0.25
        assert lr["explore"]["gamma"] == 0.5
        assert lr["explore"]["floor"] == 0.01
        assert lr["dedupe"]["t0"] == 7
        assert lr["dedupe"]["scale"] == 2
        assert lr["dedupe"]["hardWindowDays"] == 2
        
        kw = result["keyword_freshness"]
        assert kw["a50_days"] == 7.0
        assert kw["slope"] == 1.0
        assert kw["age_floor_days"] == 0.25
        assert kw["epsilon"] == 0.25
        assert kw["explore_gamma"] == 0.3
        assert kw["shown_decay"] == 0.05
        assert kw["rejected_decay"] == 0.3

    def test_freshness_config_summary_exponential_model(self):
        # freshness_config_summary in config.py expects flattened config with sampling.freshness.model
        raw = {
            "sampling": {
                "freshness": {"model": "exponential"},
                "halfLifeDays": 7,
            }
        }
        result = freshness_config_summary(raw)
        
        lr = result["lr_freshness"]
        assert lr["model"] == "exponential"
        assert lr["halfLifeDays"] == 7
        
        # Exponential curve: at half-life (7) should be 0.5
        assert lr["freshness_at_ages"]["7"] == pytest.approx(0.5, abs=0.01)

    def test_freshness_config_summary_custom_params(self):
        # Use flattened config (as expected by freshness_config_summary in config.py)
        raw = {
            "a50_days": 14.0,
            "slope": 2.0,
            "age_floor_days": 1.0,
            "halfLifeDays": 30,
            "sampling": {
                "freshness": {"model": "logistic", "steepness": 2.0},
            }
        }
        result = freshness_config_summary(raw)
        
        kw = result["keyword_freshness"]
        assert kw["a50_days"] == 14.0
        assert kw["slope"] == 2.0
        assert kw["age_floor_days"] == 1.0
        
        lr = result["lr_freshness"]
        assert lr["halfLifeDays"] == 30
        assert lr["steepness"] == 2.0

    def test_freshness_config_summary_freshness_values_monotonic(self, sample_raw_config):
        """Freshness should decrease with age (monotonic)."""
        result = freshness_config_summary(sample_raw_config)
        
        lr_values = result["lr_freshness"]["freshness_at_ages"]
        kw_values = result["keyword_freshness"]["freshness_at_ages"]
        
        ages = [0, 1, 7, 30, 50, 120]
        
        # Both should be monotonically decreasing
        for i in range(len(ages) - 1):
            assert lr_values[str(ages[i])] >= lr_values[str(ages[i+1])]
            assert kw_values[str(ages[i])] >= kw_values[str(ages[i+1])]

    def test_freshness_config_summary_at_age_zero(self):
        """Freshness at age 0 should be close to 1.0."""
        raw = {
            "a50_days": 7.0,
            "age_floor_days": 0.25,
            "halfLifeDays": 7,
        }
        result = freshness_config_summary(raw)
        
        # At age 0, keyword uses age_floor_days (0.25), so not exactly 1.0
        # f(0.25) = sigmoid((ln(7) - ln(0.25)) / 1) = sigmoid(3.33) ≈ 0.965
        kw_val = result["keyword_freshness"]["freshness_at_ages"]["0"]
        assert 0.9 < kw_val < 1.0
        
        # LR uses log1p, so at age 0: log1p(0) = 0
        # freshness = 1/(1+exp(-steepness*log1p(halfLife))) > 0.5
        lr_val = result["lr_freshness"]["freshness_at_ages"]["0"]
        assert 0.5 < lr_val <= 1.0


class TestConfigIntegration:
    """Integration tests for config module."""

    def test_load_and_merge(self, tmp_path, sample_raw_config):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(sample_raw_config))
        
        loaded = load_config(str(config_file))
        merged = merge_config(loaded, date="2026-11-01")
        
        assert merged["date"] == "2026-11-01"
        assert "a50_days" in merged
        assert "halfLifeDays" in merged

    def test_freshness_summary_from_merged(self, sample_raw_config):
        merged = merge_config(sample_raw_config)
        summary = freshness_config_summary(merged)
        
        assert "lr_freshness" in summary
        assert "keyword_freshness" in summary


# Fixtures
@pytest.fixture
def sample_raw_config():
    """Sample raw config from config.json."""
    return {
        "date": "2026-10-29",
        "ranker": {
            "sampling": {
                "epsilon": 0.25,
                "halfLifeDays": 7,
                "freshness": {"model": "logistic", "steepness": 1.386},
                "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                "explore": {"gamma": 0.5, "floor": 0.01},
                "slots": {"primary": 5, "science": 5, "reserve": 25},
            }
        },
        "selection": {
            "a50_days": 7.0,
            "slope": 1.0,
            "age_floor_days": 0.25,
            "epsilon": 0.25,
            "explore_gamma": 0.3,
            "shown_decay": 0.05,
            "rejected_decay": 0.3,
        }
    }


@pytest.fixture
def flat_config():
    """Flattened config without nested sections."""
    return {
        "date": "2026-10-29",
        "epsilon": 0.25,
        "halfLifeDays": 7,
        "a50_days": 7.0,
        "slope": 1.0,
        "age_floor_days": 0.25,
        "explore_gamma": 0.3,
        "shown_decay": 0.05,
        "rejected_decay": 0.3,
    }