"""Tests for Reporter class."""
from __future__ import annotations
import pytest
import json
import tempfile
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch

from simulate.core.reporter import Reporter
from simulate.core.metrics import MetricsCollector


class TestReporterInit:
    """Tests for Reporter initialization."""

    def test_init_creates_output_dir(self, tmp_path):
        output_dir = tmp_path / "test_output"
        reporter = Reporter(str(output_dir))
        
        assert reporter.output_dir == output_dir
        assert output_dir.exists()
        assert output_dir.is_dir()

    def test_init_with_existing_dir(self, tmp_path):
        output_dir = tmp_path / "existing"
        output_dir.mkdir()
        
        reporter = Reporter(str(output_dir))
        assert reporter.output_dir == output_dir


class TestWriteJson:
    """Tests for write_json method."""

    def test_write_json_basic(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        data = {"key": "value", "number": 42, "list": [1, 2, 3]}
        
        path = reporter.write_json(data, "test.json")
        
        assert path == tmp_path / "test.json"
        assert path.exists()
        
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded == data

    def test_write_json_unicode(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        data = {"unicode": "日本語", "emoji": "🚀", "special": "café"}
        
        path = reporter.write_json(data, "unicode.json")
        
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded == data

    def test_write_json_overwrites(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        
        reporter.write_json({"v": 1}, "same.json")
        reporter.write_json({"v": 2}, "same.json")
        
        with open(tmp_path / "same.json", encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded == {"v": 2}

    def test_write_json_nested_dirs(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        data = {"nested": True}
        
        # Ensure parent directory exists
        (tmp_path / "subdir").mkdir()
        path = reporter.write_json(data, "subdir/nested.json")
        
        assert path.exists()
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded == data


class TestWriteHtml:
    """Tests for write_html method."""

    def test_write_html_basic(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        html = "<html><body>Hello</body></html>"
        
        path = reporter.write_html(html, "test.html")
        
        assert path == tmp_path / "test.html"
        assert path.exists()
        
        with open(path, encoding="utf-8") as f:
            content = f.read()
        assert content == html


class TestPrintConsole:
    """Tests for print_console method."""

    def test_print_console(self, capsys):
        reporter = Reporter("dummy")
        data = {"key": "value"}
        
        reporter.print_console(data)
        
        captured = capsys.readouterr()
        # Should be valid JSON
        loaded = json.loads(captured.out.strip())
        assert loaded == data


class TestGenerateComparisonHtml:
    """Tests for generate_comparison_html method."""

    @pytest.fixture
    def sample_results(self):
        """Sample results for HTML generation."""
        return {
            "date": "2026-10-29",
            "seeds": [1, 2, 3],
            "engines": ["keyword", "lr"],
            "config": {
                "selection": {
                    "a50_days": 7.0,
                    "slope": 1.0,
                    "age_floor_days": 0.25,
                    "epsilon": 0.25,
                    "explore_gamma": 0.3,
                    "shown_decay": 0.05,
                    "rejected_decay": 0.3,
                },
                "sampling": {
                    "epsilon": 0.25,
                    "halfLifeDays": 7,
                    "freshness": {"model": "logistic", "steepness": 1.386},
                    "explore": {"gamma": 0.5, "floor": 0.01},
                    "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                    "slots": {"primary": 5, "science": 5, "reserve": 25},
                },
            },
            "runs": [
                {
                    "seed": 1,
                    "selections": {
                        "keyword": {
                            "primary": [
                                {"id": "1", "mode": "greedy", "age_days": 1.0, "source_type": "researchlike"},
                                {"id": "2", "mode": "explore", "age_days": 2.0, "source_type": "researchlike"},
                                {"id": "3", "mode": "greedy", "age_days": 0.5, "source_type": "newslike"},
                            ],
                            "science": [
                                {"id": "4", "mode": "greedy", "age_days": 5.0, "source_type": "researchlike"},
                            ],
                        },
                        "lr": {
                            "primary": [
                                {"id": "1", "mode": "greedy", "age_days": 1.0, "source_type": "researchlike", "cluster": 0},
                                {"id": "5", "mode": "explore", "age_days": 3.0, "source_type": "newslike", "cluster": 1},
                            ],
                            "science": [
                                {"id": "6", "mode": "greedy", "age_days": 2.0, "source_type": "researchlike", "cluster": 2},
                            ],
                        },
                    },
                },
            ],
            "cluster_metadata": {
                "total": 10,
                "core_count": 5,
                "side_count": 5,
                "clusters": [
                    {"id": 0, "medoid_title": "Cluster 0", "size": 20, "core": True},
                    {"id": 1, "medoid_title": "Cluster 1", "size": 15, "core": True},
                    {"id": 5, "medoid_title": "Cluster 5", "size": 10, "core": False},
                ],
            },
        }

    def test_generate_comparison_html_basic(self, sample_results):
        reporter = Reporter("dummy")
        
        html = reporter.generate_comparison_html(sample_results, "Test Report")
        
        assert isinstance(html, str)
        assert len(html) > 1000  # Should be substantial
        assert "<html>" in html.lower()
        assert "<title>Test Report</title>" in html
        assert "Test Report" in html
        assert "2026-10-29" in html
        assert "keyword" in html.lower()
        assert "lr" in html.lower()

    def test_generate_comparison_html_contains_charts(self, sample_results):
        reporter = Reporter("dummy")
        
        html = reporter.generate_comparison_html(sample_results, "Test")
        
        # Check for Plotly.js inclusion
        assert "plotly" in html.lower()
        # Check for chart divs (Plotly generates divs with class plotly-graph-div)
        assert "plotly-graph-div" in html
        # Check for source type and mode charts
        assert "Source Type Distribution" in html
        assert "Selection Mode Distribution" in html
        # Check for cluster chart
        assert "Cluster Coverage" in html
        # Check for age histograms
        assert "Age Histograms" in html

    def test_generate_comparison_html_freshness_config(self, sample_results):
        reporter = Reporter("dummy")
        
        html = reporter.generate_comparison_html(sample_results, "Test")
        
        assert "Freshness Configuration" in html
        assert "LR Engine Freshness" in html
        assert "Keyword Engine Freshness" in html
        assert "halfLifeDays" in html
        assert "a50_days" in html

    def test_generate_comparison_html_cluster_details(self, sample_results):
        reporter = Reporter("dummy")
        
        html = reporter.generate_comparison_html(sample_results, "Test")
        
        assert "LR Cluster Details" in html
        assert "CORE" in html
        assert "SIDE" in html
        assert "Cluster 0" in html

    def test_generate_comparison_html_missing_cluster_metadata(self, sample_results):
        reporter = Reporter("dummy")
        del sample_results["cluster_metadata"]
        
        html = reporter.generate_comparison_html(sample_results, "Test")
        
        assert "No cluster metadata available" in html

    def test_generate_comparison_html_minimal_results(self):
        reporter = Reporter("dummy")
        minimal = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword"],
            "config": {},
            "runs": [
                {
                    "seed": 1,
                    "selections": {
                        "keyword": {
                            "primary": [],
                            "science": [],
                        }
                    },
                }
            ],
        }
        
        html = reporter.generate_comparison_html(minimal, "Minimal")
        
        assert "Minimal" in html
        # Should not crash on empty data
        assert "plotly" in html.lower()

    def test_generate_comparison_html_handles_empty_selections(self):
        reporter = Reporter("dummy")
        results = {
            "date": "2026-10-29",
            "seeds": [1, 2],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [
                {
                    "seed": 1,
                    "selections": {
                        "keyword": {"primary": [], "science": []},
                        "lr": {"primary": [], "science": []},
                    },
                },
                {
                    "seed": 2,
                    "selections": {
                        "keyword": {"primary": [], "science": []},
                        "lr": {"primary": [], "science": []},
                    },
                },
            ],
        }
        
        html = reporter.generate_comparison_html(results, "Empty")
        
        assert "Empty" in html
        # Should not crash on empty data


class TestDeskTableMacro:
    """Tests for desk_table_rows macro via template rendering."""

    def test_desk_table_with_both_engines(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {
                        "primary": [
                            {"id": "1", "source_type": "researchlike", "mode": "greedy", "age_days": 1.0},
                            {"id": "2", "source_type": "researchlike", "mode": "explore", "age_days": 2.0},
                            {"id": "3", "source_type": "researchlike", "mode": "greedy", "age_days": 3.0},
                            {"id": "4", "source_type": "researchlike", "mode": "greedy", "age_days": 4.0},
                            {"id": "5", "source_type": "researchlike", "mode": "greedy", "age_days": 5.0},
                        ],
                        "science": [],
                    },
                    "lr": {
                        "primary": [
                            {"id": "1", "source_type": "researchlike", "mode": "greedy", "age_days": 2.0, "cluster": 0},
                            {"id": "2", "source_type": "researchlike", "mode": "greedy", "age_days": 3.0, "cluster": 0},
                            {"id": "3", "source_type": "researchlike", "mode": "greedy", "age_days": 4.0, "cluster": 0},
                            {"id": "4", "source_type": "researchlike", "mode": "greedy", "age_days": 5.0, "cluster": 0},
                            {"id": "5", "source_type": "researchlike", "mode": "greedy", "age_days": 6.0, "cluster": 0},
                        ],
                        "science": [],
                    },
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        # Verify desk table content
        assert "Total picks" in html
        assert "5" in html  # count
        assert "Mean age" in html
        assert "3.0" in html  # mean of [1,2,3,4,5]
        assert "4.0" in html  # mean of [2,3,4,5,6]
        assert "+1.0" in html  # diff

    def test_desk_table_missing_engine(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {
                        "primary": [
                            {"id": "1", "source_type": "researchlike", "mode": "greedy", "age_days": 1.0},
                            {"id": "2", "source_type": "researchlike", "mode": "greedy", "age_days": 2.0},
                        ],
                        "science": [],
                    },
                    "lr": {
                        "primary": [],
                        "science": [],
                    },
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        assert "Total picks" in html
        assert "2" in html  # count


class TestSummaryTableMacro:
    """Tests for summary_table_rows macro via template rendering."""

    def test_summary_table_basic(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {
                        "primary": [
                            {"id": "1", "source_type": "researchlike", "mode": "greedy", "age_days": 10.0},
                            {"id": "2", "source_type": "researchlike", "mode": "greedy", "age_days": 10.0},
                        ],
                        "science": [
                            {"id": "3", "source_type": "newslike", "mode": "explore", "age_days": 5.0},
                        ],
                    },
                    "lr": {
                        "primary": [
                            {"id": "1", "source_type": "researchlike", "mode": "greedy", "age_days": 8.0, "cluster": 0},
                            {"id": "4", "source_type": "researchlike", "mode": "greedy", "age_days": 8.0, "cluster": 0},
                        ],
                        "science": [
                            {"id": "5", "source_type": "newslike", "mode": "explore", "age_days": 3.0, "cluster": 1},
                        ],
                    },
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        assert "Researchlike %" in html
        assert "Mean age" in html
        assert "Explore rate" in html
        assert "Jaccard" in html


class TestFreshnessConfigMacro:
    """Tests for freshness_config_html macro via template rendering."""

    def test_freshness_config_html_both(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {
                "lr_freshness": {
                    "model": "logistic",
                    "halfLifeDays": 7,
                    "steepness": 1.386,
                    "epsilon": 0.25,
                    "explore": {"gamma": 0.5, "floor": 0.01},
                    "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                    "slots": {"primary": 5, "science": 5, "reserve": 25},
                    "freshness_at_ages": {"0": 1.0, "7": 0.5, "30": 0.1},
                },
                "keyword_freshness": {
                    "model": "logistic_in_log_age",
                    "a50_days": 7.0,
                    "slope": 1.0,
                    "age_floor_days": 0.25,
                    "epsilon": 0.25,
                    "explore_gamma": 0.3,
                    "shown_decay": 0.05,
                    "rejected_decay": 0.3,
                    "freshness_at_ages": {"0": 1.0, "7": 0.5, "30": 0.1},
                },
            },
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {"primary": [], "science": []},
                    "lr": {"primary": [], "science": []},
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        assert "LR Engine Freshness" in html
        assert "Keyword Engine Freshness" in html
        assert "halfLifeDays" in html
        assert "a50_days" in html
        assert "logistic" in html
        assert "1.0" in html  # freshness value

    def test_freshness_config_html_defaults_used(self, tmp_path):
        """Test that default freshness config is shown when no config provided."""
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {"primary": [], "science": []},
                    "lr": {"primary": [], "science": []},
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        # Defaults should be shown for both engines
        assert "LR Engine Freshness" in html
        assert "Keyword Engine Freshness" in html
        assert "halfLifeDays" in html
        assert "a50_days" in html
        # Default values
        assert "7" in html  # default halfLifeDays / a50_days

    def test_freshness_config_html_lr_custom_keyword_default(self, tmp_path):
        """Test with custom LR config but default keyword config."""
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {
                "sampling": {
                    "halfLifeDays": 14,
                    "epsilon": 0.1,
                    "freshness": {"model": "logistic", "steepness": 2.0},
                    "explore": {"gamma": 0.5, "floor": 0.01},
                    "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                    "slots": {"primary": 5, "science": 5, "reserve": 25},
                },
            },
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {"primary": [], "science": []},
                    "lr": {"primary": [], "science": []},
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        assert "LR Engine Freshness" in html
        assert "Keyword Engine Freshness" in html
        # Custom LR value
        assert "14" in html  # custom halfLifeDays
        # Default keyword value
        assert "7.0" in html  # default a50_days


class TestClusterDetailsMacro:
    """Tests for cluster_details macro via template rendering."""

    def test_cluster_details_with_metadata(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {"primary": [], "science": []},
                    "lr": {"primary": [], "science": []},
                },
            }],
            "cluster_metadata": {
                "total": 10,
                "core_count": 5,
                "side_count": 5,
                "clusters": [
                    {"id": 0, "medoid_title": "Cluster 0", "size": 20, "core": True},
                    {"id": 1, "medoid_title": "Cluster 1", "size": 15, "core": True},
                    {"id": 5, "medoid_title": "Cluster 5", "size": 10, "core": False},
                ],
            },
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        assert "Total clusters" in html
        assert "10" in html
        assert "Core clusters" in html
        assert "5" in html
        assert "Side clusters" in html
        assert "CORE" in html
        assert "SIDE" in html
        assert "Cluster 0" in html
        assert "Cluster 5" in html

    def test_cluster_details_missing_metadata(self, tmp_path):
        reporter = Reporter(str(tmp_path))
        results = {
            "date": "2026-10-29",
            "seeds": [1],
            "engines": ["keyword", "lr"],
            "config": {},
            "runs": [{
                "seed": 1,
                "selections": {
                    "keyword": {"primary": [], "science": []},
                    "lr": {"primary": [], "science": []},
                },
            }],
        }
        
        html = reporter.generate_comparison_html(results, "Test")
        
        assert "No cluster metadata available" in html


class TestClusterChart:
    """Tests for cluster chart generation (now in viz.charts)."""

    def test_cluster_chart_with_data(self):
        from simulate.viz.charts import create_cluster_chart
        
        js = create_cluster_chart([0, 1, 2, 5, 6], [10, 8, 5, 3, 2])
        
        assert "plotly-graph-div" in js or "Plotly.newPlot" in js
        assert "C0" in js
        assert "C1" in js
        assert "rgba(39,174,96,0.7)" in js  # core color (for clusters < 5)
        assert "rgba(241,196,15,0.7)" in js  # side color (for clusters >= 5)

    def test_cluster_chart_empty(self):
        from simulate.viz.charts import create_cluster_chart
        
        js = create_cluster_chart([], [])
        
        assert js == ""


class TestReporterIntegration:
    """Integration tests for full report generation."""

    def test_full_report_generation_and_save(self, tmp_path, sample_results):
        """Test generating and saving a full HTML report."""
        reporter = Reporter(str(tmp_path))
        
        html = reporter.generate_comparison_html(sample_results, "Integration Test")
        path = reporter.write_html(html, "report.html")
        
        assert path.exists()
        content = path.read_text(encoding="utf-8")
        assert content == html
        assert "Integration Test" in content

    def test_json_and_html_same_data(self, tmp_path, sample_results):
        """Test that JSON and HTML reports can be generated from same data."""
        reporter = Reporter(str(tmp_path))
        
        json_path = reporter.write_json(sample_results, "data.json")
        html = reporter.generate_comparison_html(sample_results, "Test")
        html_path = reporter.write_html(html, "report.html")
        
        assert json_path.exists()
        assert html_path.exists()
        
        # Verify JSON is valid
        with open(json_path, encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded == sample_results


# Fixtures
@pytest.fixture
def sample_results():
    """Sample results for HTML generation."""
    return {
        "date": "2026-10-29",
        "seeds": [1, 2, 3],
        "engines": ["keyword", "lr"],
        "config": {
            "selection": {
                "a50_days": 7.0,
                "slope": 1.0,
                "age_floor_days": 0.25,
                "epsilon": 0.25,
                "explore_gamma": 0.3,
                "shown_decay": 0.05,
                "rejected_decay": 0.3,
            },
            "sampling": {
                "epsilon": 0.25,
                "halfLifeDays": 7,
                "freshness": {"model": "logistic", "steepness": 1.386},
                "explore": {"gamma": 0.5, "floor": 0.01},
                "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                "slots": {"primary": 5, "science": 5, "reserve": 25},
            },
        },
        "runs": [
            {
                "seed": 1,
                "selections": {
                    "keyword": {
                        "primary": [
                            {"id": "1", "mode": "greedy", "age_days": 1.0, "source_type": "researchlike"},
                            {"id": "2", "mode": "explore", "age_days": 2.0, "source_type": "researchlike"},
                            {"id": "3", "mode": "greedy", "age_days": 0.5, "source_type": "newslike"},
                        ],
                        "science": [
                            {"id": "4", "mode": "greedy", "age_days": 5.0, "source_type": "researchlike"},
                        ],
                    },
                    "lr": {
                        "primary": [
                            {"id": "1", "mode": "greedy", "age_days": 1.0, "source_type": "researchlike", "cluster": 0},
                            {"id": "5", "mode": "explore", "age_days": 3.0, "source_type": "newslike", "cluster": 1},
                        ],
                        "science": [
                            {"id": "6", "mode": "greedy", "age_days": 2.0, "source_type": "researchlike", "cluster": 2},
                        ],
                    },
                },
            },
        ],
        "cluster_metadata": {
            "total": 10,
            "core_count": 5,
            "side_count": 5,
            "clusters": [
                {"id": 0, "medoid_title": "Cluster 0", "size": 20, "core": True},
                {"id": 1, "medoid_title": "Cluster 1", "size": 15, "core": True},
                {"id": 5, "medoid_title": "Cluster 5", "size": 10, "core": False},
            ],
        },
    }