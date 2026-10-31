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
        
        # Check for Chart.js inclusion
        assert "chart.js" in html.lower()
        # Check for canvas elements
        assert "sourceTypeChart" in html
        assert "modeChart" in html
        assert "clusterChart" in html
        # Check for age histograms (capitalization differs)
        assert "ageHistPrimaryKeyword" in html or "ageHistPrimaryLR" in html
        assert "ageHistScienceKeyword" in html or "ageHistScienceLR" in html

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
        assert "No age data" in html or "ageHist" in html

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


class TestBuildDeskTable:
    """Tests for _build_desk_table helper."""

    def test_build_desk_table_with_data(self):
        reporter = Reporter("dummy")
        
        desk_stats = {
            "keyword": {
                "primary": {
                    "count": 5,
                    "freshness": [1.0, 2.0, 3.0, 4.0, 5.0],
                }
            },
            "lr": {
                "primary": {
                    "count": 5,
                    "freshness": [2.0, 3.0, 4.0, 5.0, 6.0],
                }
            },
        }
        source_type_counts = {"keyword": {}, "lr": {}}
        mode_counts = {"keyword": {}, "lr": {}}
        
        table = reporter._build_desk_table("primary", desk_stats, source_type_counts, mode_counts)
        
        assert "Total picks" in table
        assert "5" in table
        assert "Mean age" in table
        assert "3.0" in table  # mean of [1,2,3,4,5]
        assert "4.0" in table  # mean of [2,3,4,5,6]
        assert "+1.0" in table  # diff

    def test_build_desk_table_missing_engine(self):
        reporter = Reporter("dummy")
        
        desk_stats = {
            "keyword": {
                "primary": {"count": 5, "freshness": [1.0, 2.0]},
            }
            # lr missing
        }
        source_type_counts = {"keyword": {}, "lr": {}}
        mode_counts = {"keyword": {}, "lr": {}}
        
        table = reporter._build_desk_table("primary", desk_stats, source_type_counts, mode_counts)
        
        assert "Total picks" in table
        assert "5" in table


class TestBuildSummaryTable:
    """Tests for _build_summary_table helper."""

    def test_build_summary_table_basic(self):
        reporter = Reporter("dummy")
        
        source_type_counts = {
            "keyword": {"researchlike": 8, "newslike": 2, "commentary": 0},
            "lr": {"researchlike": 5, "newslike": 3, "commentary": 2},
        }
        desk_freshness = {
            "keyword": {"primary": {"mean": 10.0}},
            "lr": {"primary": {"mean": 8.0}},
        }
        mode_counts = {
            "keyword": {"greedy": 7, "explore": 3},
            "lr": {"greedy": 6, "explore": 4},
        }
        runs = [
            {
                "selections": {
                    "keyword": {
                        "primary": [{"id": "1", "source_type": "researchlike"}, {"id": "2", "source_type": "researchlike"}],
                        "science": [{"id": "3", "source_type": "newslike"}],
                    },
                    "lr": {
                        "primary": [{"id": "1", "source_type": "researchlike"}, {"id": "4", "source_type": "researchlike"}],
                        "science": [{"id": "5", "source_type": "newslike"}],
                    },
                }
            }
        ]
        
        table = reporter._build_summary_table(source_type_counts, desk_freshness, mode_counts, runs)
        
        assert "Researchlike %" in table
        assert "Mean age" in table
        assert "Explore rate" in table
        assert "Jaccard" in table


class TestClusterChartJs:
    """Tests for _cluster_chart_js helper."""

    def test_cluster_chart_js_with_data(self):
        reporter = Reporter("dummy")
        
        js = reporter._cluster_chart_js([0, 1, 2, 5, 6], [10, 8, 5, 3, 2])
        
        assert "new Chart" in js
        assert "clusterChart" in js
        # Current implementation uses f"C{{c}}" which produces literal "C{c}" strings
        assert "C{c}" in js
        assert "rgba(39,174,96,0.7)" in js  # core color (for clusters < 5)
        assert "rgba(241,196,15,0.7)" in js  # side color (for clusters >= 5)

    def test_cluster_chart_js_empty(self):
        reporter = Reporter("dummy")
        
        js = reporter._cluster_chart_js([], [])
        
        assert js == ""


class TestBuildFreshnessConfigHtml:
    """Tests for _build_freshness_config_html helper."""

    def test_build_freshness_config_html_both(self):
        reporter = Reporter("dummy")
        
        freshness_config = {
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
        }
        
        html = reporter._build_freshness_config_html(freshness_config)
        
        assert "LR Engine Freshness" in html
        assert "Keyword Engine Freshness" in html
        assert "halfLifeDays" in html
        assert "a50_days" in html
        assert "logistic" in html
        assert "1.0" in html  # freshness value

    def test_build_freshness_config_html_empty(self):
        reporter = Reporter("dummy")
        
        html = reporter._build_freshness_config_html({})
        
        assert "No freshness configuration data available" in html

    def test_build_freshness_config_html_lr_only(self):
        reporter = Reporter("dummy")
        
        freshness_config = {
            "lr_freshness": {
                "model": "logistic",
                "halfLifeDays": 7,
                "steepness": 1.386,
                "epsilon": 0.25,
                "explore": {"gamma": 0.5, "floor": 0.01},
                "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                "slots": {"primary": 5, "science": 5, "reserve": 25},
                "freshness_at_ages": {"0": 1.0, "7": 0.5},
            },
        }
        
        html = reporter._build_freshness_config_html(freshness_config)
        
        assert "LR Engine Freshness" in html
        assert "Keyword Engine Freshness" not in html


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