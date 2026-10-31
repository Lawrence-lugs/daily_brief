"""Reporter - outputs results in JSON, HTML, or console format."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Dict, Any, List
from collections import Counter

from simulate.core.metrics import MetricsCollector
from simulate.viz.charts import (
    create_source_type_chart,
    create_mode_chart,
    create_cluster_chart,
    create_combined_age_histograms,
    ENGINE_COLORS,
    ENGINE_IDS,
)

# Plotly CDN version - update here when upgrading plotly.js
PLOTLY_CDN_VERSION = "2.27.0"

try:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
except ImportError:
    Environment = None  # type: ignore


class Reporter:
    """Handles output formatting for experiment results."""
    
    def __init__(self, output_dir: str = "docs/experiments"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Initialize Jinja2 environment
        template_dir = Path(__file__).parent.parent / "templates"
        if Environment is None:
            raise RuntimeError("Jinja2 not installed. Install with: pip install jinja2")
        self._jinja_env = Environment(
            loader=FileSystemLoader(str(template_dir)),
            autoescape=select_autoescape(["html", "xml"]),
            trim_blocks=True,
            lstrip_blocks=True,
        )
    
    def write_json(self, data: Dict, filename: str) -> Path:
        """Write results as JSON."""
        path = self.output_dir / filename
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return path
    
    def write_html(self, html: str, filename: str) -> Path:
        """Write HTML report."""
        path = self.output_dir / filename
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
        return path
    
    def print_console(self, data: Dict) -> None:
        """Pretty print to console."""
        print(json.dumps(data, indent=2, ensure_ascii=False))
    
    def generate_comparison_html(self, results: Dict, title: str = "Engine Comparison") -> str:
        """Generate HTML report with Plotly visualizations using Jinja2 template."""
        # Extract data for charts
        engines = results.get("engines", [])
        runs = results.get("runs", [])
        
        # Cluster metadata from LR engine
        cluster_metadata = results.get("cluster_metadata")
        
        # Freshness configuration summary (hook + hyperparameters)
        config = results.get("config", {})
        freshness_config = MetricsCollector.freshness_config_summary(config)
        
        # Aggregate source type counts
        source_type_counts = {e: Counter() for e in engines}
        for run in runs:
            for engine in engines:
                for desk, items in run.get("selections", {}).get(engine, {}).items():
                    for item in items:
                        st = item.get("source_type", "unknown")
                        source_type_counts[engine][st] += 1
        
        # Aggregate cluster counts (for LR)
        cluster_counts = {}
        for run in runs:
            for engine in engines:
                if engine == "lr":
                    for desk, items in run.get("selections", {}).get(engine, {}).items():
                        for item in items:
                            cluster = item.get("cluster")
                            if cluster is not None:
                                cluster_counts[cluster] = cluster_counts.get(cluster, 0) + 1
        
        # Aggregate mode counts
        mode_counts = {e: Counter() for e in engines}
        for run in runs:
            for engine in engines:
                for desk, items in run.get("selections", {}).get(engine, {}).items():
                    for item in items:
                        mode = item.get("mode", "unknown")
                        mode_counts[engine][mode] += 1
        
        # Per-desk stats (including age histogram data)
        desk_stats = {}
        desk_age_histograms = {}
        for engine in engines:
            desk_stats[engine] = {}
            desk_age_histograms[engine] = {}
            for run in runs:
                for desk, items in run.get("selections", {}).get(engine, {}).items():
                    if desk not in desk_stats[engine]:
                        desk_stats[engine][desk] = {"freshness": [], "count": 0}
                        desk_age_histograms[engine][desk] = []
                    desk_stats[engine][desk]["count"] += len(items)
                    for item in items:
                        if "age_days" in item and item["age_days"] is not None:
                            desk_stats[engine][desk]["freshness"].append(item["age_days"])
                            desk_age_histograms[engine][desk].append(item["age_days"])
        
        # Build age histogram bins (0-1, 1-2, 2-5, 5-10, 10-20, 20-50, 50+)
        hist_bins = [0, 1, 2, 5, 10, 20, 50, float('inf')]
        hist_labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50+"]
        
        desk_age_hist_data = {}
        for engine in engines:
            desk_age_hist_data[engine] = {}
            for desk in desk_age_histograms.get(engine, {}):
                ages = desk_age_histograms[engine][desk]
                counts = [0] * len(hist_labels)
                for age in ages:
                    for i, (low, high) in enumerate(zip(hist_bins[:-1], hist_bins[1:])):
                        if low <= age < high:
                            counts[i] += 1
                            break
                desk_age_hist_data[engine][desk] = {
                    "labels": hist_labels,
                    "counts": counts,
                }
        
        # Prepare chart data
        source_labels = sorted(set().union(*[set(c.keys()) for c in source_type_counts.values()]))
        source_datasets = []
        for engine in engines:
            source_datasets.append({
                "label": engine.capitalize(),
                "data": [source_type_counts[engine].get(l, 0) for l in source_labels],
                "backgroundColor": ENGINE_COLORS.get(engine, {}).get("light", "rgba(100,100,100,0.7)"),
                "borderColor": ENGINE_COLORS.get(engine, {}).get("dark", "#666"),
            })
        
        cluster_labels = sorted(cluster_counts.keys())
        cluster_data = [cluster_counts.get(c, 0) for c in cluster_labels]
        
        mode_labels = sorted(set().union(*[set(c.keys()) for c in mode_counts.values()]))
        mode_totals = [
            sum(mode_counts.get(e, {}).get(l, 0) for e in engines) for l in mode_labels
        ]
        
        # Per-desk freshness summary (for backward compat / other uses)
        desk_freshness = {}
        for engine in engines:
            desk_freshness[engine] = {}
            for desk, data in desk_stats.get(engine, {}).items():
                ages = data.get("freshness", [])
                if ages:
                    desk_freshness[engine][desk] = {
                        "mean": sum(ages) / len(ages),
                        "median": sorted(ages)[len(ages)//2],
                        "count": data["count"],
                    }
        
        # Compute summary stats for template
        summary_stats = self._compute_summary_stats(runs, source_type_counts)
        
        # Generate charts using Plotly
        charts = {
            "source_type": create_source_type_chart(source_labels, source_datasets),
            "mode": create_mode_chart(mode_labels, mode_totals),
            "cluster": create_cluster_chart(cluster_labels, cluster_data),
            "combined_age_histograms": create_combined_age_histograms(desk_age_hist_data),
        }
        
        # Render template - pass raw data, let Jinja2 macros handle HTML generation
        template = self._jinja_env.get_template("report.html.j2")
        seeds = results.get("seeds", [])
        
        return template.render(
            title=title,
            date=results.get("date", "unknown"),
            seeds=seeds,
            runs=runs,
            engines=engines,
            charts=charts,
            desk_stats=desk_stats,
            source_type_counts=source_type_counts,
            mode_counts=mode_counts,
            cluster_metadata=cluster_metadata,
            freshness_config=freshness_config,
            summary_stats=summary_stats,
            plotly_cdn_version=PLOTLY_CDN_VERSION,
        )
    
    def _compute_summary_stats(self, runs: List[Dict], source_type_counts: Dict) -> Dict:
        """Compute summary statistics for the report template."""
        # Collect all picks per engine
        kw_picks = []
        lr_picks = []
        for run in runs:
            for desk, items in run.get("selections", {}).get("keyword", {}).items():
                kw_picks.extend(items)
            for desk, items in run.get("selections", {}).get("lr", {}).items():
                lr_picks.extend(items)
        
        def get_pct(picks, stype):
            total = len(picks)
            if total == 0: return 0
            return sum(1 for p in picks if p.get("source_type") == stype) / total * 100
        
        def get_mean_age(picks):
            ages = [p.get("age_days", 0) for p in picks if p.get("age_days") is not None]
            return sum(ages) / len(ages) if ages else 0
        
        def get_median_age(picks):
            ages = sorted([p.get("age_days", 0) for p in picks if p.get("age_days") is not None])
            return ages[len(ages)//2] if ages else 0
        
        def get_explore_pct(picks):
            total = len(picks)
            if total == 0: return 0
            return sum(1 for p in picks if p.get("mode") == "explore") / total * 100
        
        # Jaccard indices
        primary_kw = {i["id"] for run in runs for i in run.get("selections", {}).get("keyword", {}).get("primary", [])}
        primary_lr = {i["id"] for run in runs for i in run.get("selections", {}).get("lr", {}).get("primary", [])}
        science_kw = {i["id"] for run in runs for i in run.get("selections", {}).get("keyword", {}).get("science", [])}
        science_lr = {i["id"] for run in runs for i in run.get("selections", {}).get("lr", {}).get("science", [])}
        
        jaccard_primary = MetricsCollector.jaccard(primary_kw, primary_lr)
        jaccard_science = MetricsCollector.jaccard(science_kw, science_lr)
        
        return {
            "researchlike_kw": get_pct(kw_picks, "researchlike"),
            "researchlike_lr": get_pct(lr_picks, "researchlike"),
            "newslike_kw": get_pct(kw_picks, "newslike"),
            "newslike_lr": get_pct(lr_picks, "newslike"),
            "commentary_kw": get_pct(kw_picks, "commentary"),
            "commentary_lr": get_pct(lr_picks, "commentary"),
            "mean_age_kw": get_mean_age(kw_picks),
            "mean_age_lr": get_mean_age(lr_picks),
            "median_age_kw": get_median_age(kw_picks),
            "median_age_lr": get_median_age(lr_picks),
            "explore_rate_kw": get_explore_pct(kw_picks),
            "explore_rate_lr": get_explore_pct(lr_picks),
            "jaccard_primary": jaccard_primary,
            "jaccard_science": jaccard_science,
        }