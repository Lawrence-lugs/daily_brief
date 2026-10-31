"""Reporter - outputs results in JSON, HTML, or console format."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime
from collections import Counter

from simulate.core.metrics import MetricsCollector


class Reporter:
    """Handles output formatting for experiment results."""
    
    def __init__(self, output_dir: str = "docs/experiments"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
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
        """Generate HTML report with Chart.js visualizations."""
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
        
        # Build HTML
        return self._build_html_report(
            title=title,
            date=results.get("date", "unknown"),
            seeds=results.get("seeds", []),
            engines=engines,
            source_type_counts=source_type_counts,
            cluster_counts=cluster_counts,
            mode_counts=mode_counts,
            desk_stats=desk_stats,
            desk_age_hist_data=desk_age_hist_data,
            cluster_metadata=cluster_metadata,
            runs=runs,
            freshness_config=freshness_config,
        )
    
    def _build_html_report(self, **kwargs) -> str:
            """Build the HTML report string."""
            from html import escape as esc

            engines = kwargs["engines"]
            source_type_counts = kwargs["source_type_counts"]
            cluster_counts = kwargs["cluster_counts"]
            mode_counts = kwargs["mode_counts"]
            desk_stats = kwargs["desk_stats"]
            runs = kwargs["runs"]
            cluster_metadata = kwargs.get("cluster_metadata")
            desk_age_hist_data = kwargs.get("desk_age_hist_data", {})
            freshness_config = kwargs.get("freshness_config", {})

            # Colors
            engine_colors = {
                "keyword": {"main": "#e74c3c", "light": "rgba(231,76,60,0.7)", "dark": "#c0392b"},
                "lr": {"main": "#27ae60", "light": "rgba(39,174,96,0.7)", "dark": "#1e8449"},
            }
            engine_ids = {"keyword": "Keyword", "lr": "LR"}

            # Source type chart data
            source_labels = sorted(set().union(*[set(c.keys()) for c in source_type_counts.values()]))
            source_datasets = []
            for engine in engines:
                source_datasets.append({
                    "label": engine.capitalize(),
                    "data": [source_type_counts[engine].get(l, 0) for l in source_labels],
                    "backgroundColor": engine_colors.get(engine, {}).get("light", "rgba(100,100,100,0.7)"),
                    "borderColor": engine_colors.get(engine, {}).get("dark", "#666"),
                    "borderWidth": 1,
                })

            # Cluster chart data (LR only)
            cluster_labels = sorted(cluster_counts.keys())
            cluster_data = [cluster_counts.get(c, 0) for c in cluster_labels]
            cluster_chart_js = (
                self._cluster_chart_js(cluster_labels, cluster_data)
                if cluster_labels else "// No cluster data"
            )

            # Mode chart data
            mode_labels = sorted(set().union(*[set(c.keys()) for c in mode_counts.values()]))
            mode_totals = [
                sum(mode_counts.get(e, {}).get(l, 0) for e in engines) for l in mode_labels
            ]
            mode_colors = ["rgba(231,76,60,0.7)", "rgba(39,174,96,0.7)", "rgba(241,196,15,0.7)"][:len(mode_labels)]

            # Per-desk freshness
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

            # Header info
            seeds = kwargs.get("seeds", [])
            seed_range = f"{seeds[0]}...{seeds[-1]}" if seeds else "n/a"

            # ---- LR cluster details card ----
            if cluster_metadata:
                clusters = sorted(
                    cluster_metadata.get("clusters", []),
                    key=lambda c: c.get("id", 0),
                )
                total = cluster_metadata.get("total", len(clusters))
                core_count = cluster_metadata.get("core_count", sum(1 for c in clusters if c.get("core")))
                side_count = cluster_metadata.get("side_count", total - core_count)

                cluster_row_list = []
                for c in clusters:
                    is_core = bool(c.get("core"))
                    badge_cls = "badge-core" if is_core else "badge-side"
                    badge_txt = "CORE" if is_core else "SIDE"
                    cluster_row_list.append(
                        "<tr>"
                        f"<td>C{esc(str(c.get('id', '?')))}</td>"
                        f"<td>{esc(str(c.get('medoid_title', '')))}</td>"
                        f"<td>{c.get('size', 0)}</td>"
                        f'<td><span class="badge {badge_cls}">{badge_txt}</span></td>'
                        "</tr>"
                    )
                cluster_rows = "".join(cluster_row_list)

                cluster_details_html = f"""
            <div class="metric-grid">
                <div class="metric-card">
                    <div class="metric-value">{total}</div>
                    <div class="metric-label">Total clusters</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">{core_count}</div>
                    <div class="metric-label">Core clusters</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">{side_count}</div>
                    <div class="metric-label">Side clusters</div>
                </div>
            </div>
            <table style="margin-top: 15px;">
                <tr><th>Cluster</th><th>Medoid Title</th><th>Size</th><th>Type</th></tr>
                {cluster_rows}
            </table>"""
            else:
                cluster_details_html = "<p><small>No cluster metadata available.</small></p>"

            # ---- Age histogram canvases + JS ----
            def _hist_canvas(desk: str, engine: str) -> str:
                canvas_id = f"ageHist{desk.capitalize()}{engine_ids.get(engine, engine.capitalize())}"
                has_data = bool(desk_age_hist_data.get(engine, {}).get(desk))
                if has_data:
                    return f'<div class="chart-container"><canvas id="{canvas_id}"></canvas></div>'
                return (
                    '<div class="chart-container"><p><small>'
                    f"No age data for {esc(engine)} / {esc(desk)}.</small></p></div>"
                )

            def _hist_block(desk: str) -> str:
                return (
                    '<div class="grid hist-grid">'
                    f'{_hist_canvas(desk, "keyword")}'
                    f'{_hist_canvas(desk, "lr")}'
                    "</div>"
                )

            age_hist_js_parts = []
            for desk in ("primary", "science"):
                for engine in ("keyword", "lr"):
                    hist = desk_age_hist_data.get(engine, {}).get(desk)
                    if not hist:
                        continue
                    canvas_id = f"ageHist{desk.capitalize()}{engine_ids[engine]}"
                    colors = engine_colors[engine]
                    config = {
                        "type": "bar",
                        "data": {
                            "labels": hist.get("labels", []),
                            "datasets": [{
                                "label": f"{engine_ids[engine]} picks",
                                "data": hist.get("counts", []),
                                "backgroundColor": colors["light"],
                                "borderColor": colors["dark"],
                                "borderWidth": 1,
                            }],
                        },
                        "options": {
                            "responsive": True,
                            "maintainAspectRatio": False,
                            "plugins": {
                                "title": {
                                    "display": True,
                                    "text": f"{desk.capitalize()} Desk - {engine_ids[engine]} Age Histogram",
                                },
                                "legend": {"display": False},
                            },
                            "scales": {
                                "y": {"beginAtZero": True, "title": {"display": True, "text": "Picks"}},
                                "x": {"title": {"display": True, "text": "Age (days)"}},
                            },
                        },
                    }
                    age_hist_js_parts.append(
                        f'new Chart(document.getElementById("{canvas_id}"), {json.dumps(config)});'
                    )
            age_hist_js = "\n        ".join(age_hist_js_parts) if age_hist_js_parts else "// No age histogram data"

            html = f"""<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>{esc(str(kwargs['title']))}</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                max-width: 1200px; margin: auto; padding: 20px; background: #f5f5f5; }}
            .card {{ background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; 
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
            .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }}
            .hist-grid {{ grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 15px; }}
            .hist-grid .chart-container {{ height: 250px; }}
            .chart-container {{ position: relative; height: 350px; }}
            table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
            th, td {{ padding: 8px; border-bottom: 1px solid #eee; text-align: left; }}
            th {{ background: #f8f9fa; font-weight: 600; }}
            .engine-kw {{ border-left: 4px solid #e74c3c; }}
            .engine-lr {{ border-left: 4px solid #27ae60; }}
            .highlight {{ background: #fff3cd; }}
            pre {{ background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 13px; }}
            .badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; 
                    font-weight: 600; color: white; }}
            .badge-kw {{ background: #e74c3c; }}
            .badge-lr {{ background: #27ae60; }}
            .badge-core {{ background: #27ae60; }}
            .badge-side {{ background: #f1c40f; color: #333; }}
            h1 {{ color: #333; }}
            h2 {{ color: #444; border-bottom: 1px solid #eee; padding-bottom: 10px; }}
            h3 {{ color: #555; }}
            .metric-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }}
            .metric-card {{ background: #f8f9fa; padding: 15px; border-radius: 6px; }}
            .metric-value {{ font-size: 24px; font-weight: 700; color: #333; }}
            .metric-label {{ font-size: 12px; color: #666; text-transform: uppercase; }}
        </style>
    </head>
    <body>
        <h1>{esc(str(kwargs['title']))}</h1>
        <p>Date: {esc(str(kwargs['date']))} | Seeds: {len(seeds)} ({seed_range}) | Runs: {len(runs)}</p>
        
        <div class="card engine-kw">
            <h2><span class="badge badge-kw">KEYWORD</span> Keyword Engine (Legacy)</h2>
            <p>Epsilon-greedy with keyword relevance, freshness decay, subtopic balancing.</p>
        </div>
        
        <div class="card engine-lr">
            <h2><span class="badge badge-lr">LR</span> LR Engine (New)</h2>
            <p>Bayesian logistic regression, Ward clustering, value-based sampling with cluster round-robin.</p>
        </div>
        
        <div class="card">
            <h2>Source Type Distribution</h2>
            <div class="grid">
                <div class="chart-container">
                    <canvas id="sourceTypeChart"></canvas>
                </div>
                <div class="chart-container">
                    <canvas id="modeChart"></canvas>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>Cluster Coverage (LR Engine)</h2>
            <div class="chart-container">
                <canvas id="clusterChart"></canvas>
            </div>
            <p><small>Green = core clusters (guaranteed 1 pick/day via round-robin), Yellow = side clusters</small></p>
        </div>
        
        <div class="card">
            <h2>Freshness Configuration (Hook + Hyperparameters)</h2>
            <p><small>Freshness decay functions and config hyperparameters used in this experiment.</small></p>
            {self._build_freshness_config_html(freshness_config)}
        </div>
        
        <div class="card">
            <h2>LR Cluster Details</h2>
            {cluster_details_html}
        </div>
        
        <div class="card">
            <h2>Per-Desk Metrics</h2>
            <div class="grid">
                <div>
                    <h3>Primary Desk</h3>
                    <table>
                        <tr><th>Metric</th><th>Keyword</th><th>LR</th><th>Diff</th></tr>
                        {self._build_desk_table("primary", desk_stats, source_type_counts, mode_counts)}
                    </table>
                    {_hist_block("primary")}
                </div>
                <div>
                    <h3>Science Desk</h3>
                    <table>
                        <tr><th>Metric</th><th>Keyword</th><th>LR</th><th>Diff</th></tr>
                        {self._build_desk_table("science", desk_stats, source_type_counts, mode_counts)}
                    </table>
                    {_hist_block("science")}
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>Key Metrics Summary</h2>
            <table>
                <tr><th>Metric</th><th>Keyword</th><th>LR</th><th>Diff</th></tr>
                {self._build_summary_table(source_type_counts, desk_freshness, mode_counts, runs)}
            </table>
        </div>
        
        <div class="card">
            <h2>Run Details (First 5 Seeds)</h2>
            <pre>{esc(json.dumps(runs[:5], indent=2))}</pre>
        </div>
        
        <script>
            // Source Type Chart
            new Chart(document.getElementById("sourceTypeChart"), {{
                type: "bar",
                data: {{
                    labels: {json.dumps(source_labels)},
                    datasets: {json.dumps(source_datasets)}
                }},
                options: {{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {{ title: {{ display: true, text: "Source Type Distribution (all desks, all runs)" }} }},
                    scales: {{ y: {{ beginAtZero: true, title: {{ display: true, text: "Count" }} }} }}
                }}
            }});
            
            // Mode Chart - aggregate across engines
            new Chart(document.getElementById("modeChart"), {{
                type: "doughnut",
                data: {{
                    labels: {json.dumps(mode_labels)},
                    datasets: [{{
                        label: "Selection Mode",
                        data: {json.dumps(mode_totals)},
                        backgroundColor: {json.dumps(mode_colors)},
                        borderWidth: 1
                    }}]
                }},
                options: {{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {{ title: {{ display: true, text: "Selection Mode Distribution (all engines)" }} }}
                }}
            }});
            
            // Cluster Chart (if LR data exists)
            {cluster_chart_js}
            
            // Age Histograms (per desk x engine)
            {age_hist_js}
        </script>
    </body>
    </html>"""
            return html    
    
    def _build_desk_table(self, desk: str, desk_stats: Dict, 
                          source_type_counts: Dict, mode_counts: Dict) -> str:
        """Build HTML table rows for a desk."""
        rows = []
        
        # Total picks per engine
        for engine in ["keyword", "lr"]:
            if engine in desk_stats and desk in desk_stats[engine]:
                count = desk_stats[engine][desk]["count"]
                rows.append(f"<tr><td>Total picks</td><td>{count}</td><td>--</td><td>--</td></tr>")
        
        # Freshness
        if "keyword" in desk_stats and desk in desk_stats["keyword"]:
            kw_ages = desk_stats["keyword"][desk].get("freshness", [])
            lr_ages = desk_stats.get("lr", {}).get(desk, {}).get("freshness", [])
            if kw_ages:
                kw_mean = sum(kw_ages)/len(kw_ages)
                if lr_ages:
                    lr_mean = sum(lr_ages)/len(lr_ages)
                    diff = lr_mean - kw_mean
                    rows.append(f"<tr><td>Mean age (days)</td><td>{kw_mean:.1f}</td><td>{lr_mean:.1f}</td><td>{diff:+.1f}</td></tr>")
                else:
                    rows.append(f"<tr><td>Mean age (days)</td><td>{kw_mean:.1f}</td><td>N/A</td><td>N/A</td></tr>")
            if kw_ages:
                kw_median = sorted(kw_ages)[len(kw_ages)//2]
                if lr_ages:
                    lr_median = sorted(lr_ages)[len(lr_ages)//2]
                    rows.append(f"<tr><td>Median age (days)</td><td>{kw_median:.1f}</td><td>{lr_median:.1f}</td><td>N/A</td></tr>")
                else:
                    rows.append(f"<tr><td>Median age (days)</td><td>{kw_median:.1f}</td><td>N/A</td><td>N/A</td></tr>")
        
        return "".join(rows)
    
    def _build_summary_table(self, source_type_counts: Dict, desk_freshness: Dict,
                             mode_counts: Dict, runs: List[Dict]) -> str:
        """Build summary metrics table."""
        rows = []
        
        # Source type percentages
        for engine in ["keyword", "lr"]:
            total = sum(source_type_counts.get(engine, {}).values())
            if total > 0:
                for stype in ["researchlike", "newslike", "commentary"]:
                    pct = source_type_counts[engine].get(stype, 0) / total * 100
                    # We'll fill both columns in a single pass below
        
        # Compute overall stats from runs
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
            return sum(ages)/len(ages) if ages else 0
        
        def get_median_age(picks):
            ages = sorted([p.get("age_days", 0) for p in picks if p.get("age_days") is not None])
            return ages[len(ages)//2] if ages else 0
        
        def get_explore_pct(picks):
            total = len(picks)
            if total == 0: return 0
            return sum(1 for p in picks if p.get("mode") == "explore") / total * 100
        
        # Jaccard
        primary_kw = {i["id"] for run in runs for i in run.get("selections", {}).get("keyword", {}).get("primary", [])}
        primary_lr = {i["id"] for run in runs for i in run.get("selections", {}).get("lr", {}).get("primary", [])}
        science_kw = {i["id"] for run in runs for i in run.get("selections", {}).get("keyword", {}).get("science", [])}
        science_lr = {i["id"] for run in runs for i in run.get("selections", {}).get("lr", {}).get("science", [])}
        
        from simulate.core.metrics import MetricsCollector
        jaccard_primary = MetricsCollector.jaccard(primary_kw, primary_lr)
        jaccard_science = MetricsCollector.jaccard(science_kw, science_lr)
        
        rows.append(f"<tr><td>Researchlike %</td><td>{get_pct(kw_picks, 'researchlike'):.1f}%</td><td>{get_pct(lr_picks, 'researchlike'):.1f}%</td><td class='highlight'>{get_pct(lr_picks, 'researchlike') - get_pct(kw_picks, 'researchlike'):+.1f}%</td></tr>")
        rows.append(f"<tr><td>Newslike %</td><td>{get_pct(kw_picks, 'newslike'):.1f}%</td><td>{get_pct(lr_picks, 'newslike'):.1f}%</td><td class='highlight'>{get_pct(lr_picks, 'newslike') - get_pct(kw_picks, 'newslike'):+.1f}%</td></tr>")
        rows.append(f"<tr><td>Commentary %</td><td>{get_pct(kw_picks, 'commentary'):.1f}%</td><td>{get_pct(lr_picks, 'commentary'):.1f}%</td><td>{get_pct(lr_picks, 'commentary') - get_pct(kw_picks, 'commentary'):+.1f}%</td></tr>")
        rows.append(f"<tr><td>Mean age (days)</td><td>{get_mean_age(kw_picks):.1f}</td><td>{get_mean_age(lr_picks):.1f}</td><td>{get_mean_age(lr_picks) - get_mean_age(kw_picks):+.1f}</td></tr>")
        rows.append(f"<tr><td>Median age (days)</td><td>{get_median_age(kw_picks):.1f}</td><td>{get_median_age(lr_picks):.1f}</td><td>{get_median_age(lr_picks) - get_median_age(kw_picks):+.1f}</td></tr>")
        rows.append(f"<tr><td>Explore rate</td><td>{get_explore_pct(kw_picks):.1f}%</td><td>{get_explore_pct(lr_picks):.1f}%</td><td>{get_explore_pct(lr_picks) - get_explore_pct(kw_picks):+.1f}%</td></tr>")
        rows.append(f"<tr><td>Jaccard (primary)</td><td>--</td><td>{jaccard_primary:.3f}</td><td>{'Very low' if jaccard_primary < 0.1 else 'Low' if jaccard_primary < 0.3 else 'Moderate'}</td></tr>")
        rows.append(f"<tr><td>Jaccard (science)</td><td>--</td><td>{jaccard_science:.3f}</td><td>{'No overlap' if jaccard_science == 0 else 'Very low' if jaccard_science < 0.1 else 'Low'}</td></tr>")
        
        return "".join(rows)
    
    def _cluster_chart_js(self, labels: List, data: List) -> str:
        """Generate Chart.js code for cluster chart."""
        if not labels:
            return ""
        
        # Color core vs side clusters (assuming 0-4 are core based on typical config)
        colors = []
        for i, c in enumerate(labels):
            if c < 5:
                colors.append("rgba(39,174,96,0.7)")  # core = green
            else:
                colors.append("rgba(241,196,15,0.7)")  # side = yellow
        
        return f"""
        new Chart(document.getElementById("clusterChart"), {{
            type: "bar",
            data: {{
                labels: {json.dumps([f"C{{c}}" for c in labels])},
                datasets: [{{
                    label: "Picks per run (aggregated)",
                    data: {json.dumps(data)},
                    backgroundColor: {json.dumps(colors)},
                    borderColor: {json.dumps(["#27ae60" if c < 5 else "#f1c40f" for c in labels])},
                    borderWidth: 1
                }}]
            }},
            options: {{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {{
                    title: {{ display: true, text: "LR Cluster Coverage (Green=Core, Yellow=Side)" }},
                    legend: {{ display: false }}
                }},
                scales: {{
                    y: {{ beginAtZero: true, title: {{ display: true, text: "Picks" }} }},
                    x: {{ title: {{ display: true, text: "Cluster (0-4=Core, 5+=Side)" }} }}
                }}
            }}
        }});
        """




    def _build_freshness_config_html(self, freshness_config: Dict) -> str:
        """Build HTML for the freshness configuration card."""
        from html import escape as esc

        lr = freshness_config.get("lr_freshness", {})
        kw = freshness_config.get("keyword_freshness", {})

        if not lr and not kw:
            return "<p><small>No freshness configuration data available.</small></p>"

        rows = []

        # LR freshness section
        if lr:
            lr_fa = lr.get("freshness_at_ages", {})
            rows.append("<h4>LR Engine Freshness</h4>")
            rows.append("<table>")
            rows.append("<tr><th>Parameter</th><th>Value</th><th>Description</th></tr>")
            rows.append(f"<tr><td>Model</td><td>{esc(str(lr.get('model', 'logistic')))}</td><td>Freshness decay function (logistic-in-log-age or exponential)</td></tr>")
            rows.append(f"<tr><td>halfLifeDays</td><td>{lr.get('halfLifeDays', 'n/a')}</td><td>Age at which freshness = 0.5 (logistic) or half-life (exponential)</td></tr>")
            rows.append(f"<tr><td>steepness</td><td>{lr.get('steepness', 'n/a')}</td><td>Steepness of the logistic decay curve</td></tr>")
            rows.append(f"<tr><td>epsilon</td><td>{lr.get('epsilon', 'n/a')}</td><td>Exploration probability (epsilon-greedy)</td></tr>")
            explore = lr.get("explore", {})
            rows.append(f"<tr><td>explore.gamma</td><td>{explore.get('gamma', 'n/a')}</td><td>Flattening exponent for explore weights (V^gamma)</td></tr>")
            rows.append(f"<tr><td>explore.floor</td><td>{explore.get('floor', 'n/a')}</td><td>Minimum V floor for explore weights</td></tr>")
            dedupe = lr.get("dedupe", {})
            rows.append(f"<tr><td>dedupe.t0</td><td>{dedupe.get('t0', 'n/a')}</td><td>Days-since-shown at which dedupe = 0.5</td></tr>")
            rows.append(f"<tr><td>dedupe.scale</td><td>{dedupe.get('scale', 'n/a')}</td><td>Steepness of the dedupe sigmoid</td></tr>")
            rows.append(f"<tr><td>dedupe.hardWindowDays</td><td>{dedupe.get('hardWindowDays', 'n/a')}</td><td>Items shown within this many days are excluded</td></tr>")
            slots = lr.get("slots", {})
            rows.append(f"<tr><td>slots.primary</td><td>{slots.get('primary', 'n/a')}</td><td>Number of picks for primary desk</td></tr>")
            rows.append(f"<tr><td>slots.science</td><td>{slots.get('science', 'n/a')}</td><td>Number of picks for science desk</td></tr>")
            rows.append(f"<tr><td>slots.reserve</td><td>{slots.get('reserve', 'n/a')}</td><td>Number of reserve picks per desk</td></tr>")
            rows.append("</table>")

            # Freshness curve values
            rows.append("<h5>LR Freshness at Reference Ages</h5>")
            rows.append("<table>")
            rows.append("<tr><th>Age (days)</th><th>Freshness</th></tr>")
            for age_str in sorted(lr_fa.keys(), key=int):
                rows.append(f"<tr><td>{age_str}</td><td>{lr_fa[age_str]}</td></tr>")
            rows.append("</table>")

        # Keyword freshness section
        if kw:
            kw_fa = kw.get("freshness_at_ages", {})
            rows.append("<h4>Keyword Engine Freshness</h4>")
            rows.append("<table>")
            rows.append("<tr><th>Parameter</th><th>Value</th><th>Description</th></tr>")
            rows.append(f"<tr><td>Model</td><td>{esc(str(kw.get('model', 'logistic_in_log_age')))}</td><td>f(a) = sigmoid((ln(a50) - ln(a)) / slope)</td></tr>")
            rows.append(f"<tr><td>a50_days</td><td>{kw.get('a50_days', 'n/a')}</td><td>Age at which freshness = 0.5</td></tr>")
            rows.append(f"<tr><td>slope</td><td>{kw.get('slope', 'n/a')}</td><td>Steepness of the logistic decay</td></tr>")
            rows.append(f"<tr><td>age_floor_days</td><td>{kw.get('age_floor_days', 'n/a')}</td><td>Minimum age used in log computation</td></tr>")
            rows.append(f"<tr><td>epsilon</td><td>{kw.get('epsilon', 'n/a')}</td><td>Exploration probability (epsilon-greedy)</td></tr>")
            rows.append(f"<tr><td>explore_gamma</td><td>{kw.get('explore_gamma', 'n/a')}</td><td>Flattening exponent for explore weights</td></tr>")
            rows.append(f"<tr><td>shown_decay</td><td>{kw.get('shown_decay', 'n/a')}</td><td>Per-show penalty multiplier</td></tr>")
            rows.append(f"<tr><td>rejected_decay</td><td>{kw.get('rejected_decay', 'n/a')}</td><td>Per-rejection penalty multiplier</td></tr>")
            rows.append("</table>")

            # Freshness curve values
            rows.append("<h5>Keyword Freshness at Reference Ages</h5>")
            rows.append("<table>")
            rows.append("<tr><th>Age (days)</th><th>Freshness</th></tr>")
            for age_str in sorted(kw_fa.keys(), key=int):
                rows.append(f"<tr><td>{age_str}</td><td>{kw_fa[age_str]}</td></tr>")
            rows.append("</table>")

        return "\n".join(rows)

from collections import Counter