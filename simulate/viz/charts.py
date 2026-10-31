"""Plotly chart generation for simulation reports."""
from __future__ import annotations
from typing import Dict, List
import plotly.graph_objects as go
from plotly.subplots import make_subplots


# Color scheme matching original Chart.js colors
ENGINE_COLORS = {
    "keyword": {"main": "#e74c3c", "light": "rgba(231,76,60,0.7)", "dark": "#c0392b"},
    "lr": {"main": "#27ae60", "light": "rgba(39,174,96,0.7)", "dark": "#1e8449"},
}
ENGINE_IDS = {"keyword": "Keyword", "lr": "LR"}

MODE_COLORS = ["rgba(231,76,60,0.7)", "rgba(39,174,96,0.7)", "rgba(241,196,15,0.7)"]

HIST_LABELS = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50+"]


def _fig_to_html(fig: go.Figure) -> str:
    """Convert Plotly figure to HTML div snippet (no plotly.js included)."""
    return fig.to_html(include_plotlyjs=False, full_html=False, config={"displayModeBar": False})


def create_source_type_chart(source_labels: List[str], source_datasets: List[Dict]) -> str:
    """Create grouped bar chart for source type distribution across engines."""
    fig = go.Figure()
    
    for ds in source_datasets:
        fig.add_trace(go.Bar(
            name=ds["label"],
            x=source_labels,
            y=ds["data"],
            marker_color=ds.get("backgroundColor", "rgba(100,100,100,0.7)"),
            marker_line=dict(color=ds.get("borderColor", "#666"), width=1),
        ))
    
    fig.update_layout(
        title="Source Type Distribution (all desks, all runs)",
        barmode="group",
        yaxis=dict(title="Count", rangemode="tozero"),
        xaxis=dict(title="Source Type"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=50, r=20, t=60, b=50),
        template="plotly_white",
        height=350,
    )
    
    return _fig_to_html(fig)


def create_mode_chart(mode_labels: List[str], mode_totals: List[int]) -> str:
    """Create doughnut chart for selection mode distribution."""
    fig = go.Figure(data=[go.Pie(
        labels=mode_labels,
        values=mode_totals,
        hole=0.5,
        marker=dict(
            colors=MODE_COLORS[:len(mode_labels)],
            line=dict(color="#fff", width=1),
        ),
        textinfo="label+percent",
        insidetextorientation="radial",
    )])
    
    fig.update_layout(
        title="Selection Mode Distribution (all engines)",
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=-0.1, xanchor="center", x=0.5),
        margin=dict(l=20, r=20, t=60, b=20),
        template="plotly_white",
        height=350,
    )
    
    return _fig_to_html(fig)


def create_cluster_chart(cluster_labels: List[int], cluster_data: List[int]) -> str:
    """Create bar chart for LR cluster coverage with core/side coloring."""
    if not cluster_labels:
        return ""
    
    colors = []
    border_colors = []
    for c in cluster_labels:
        if c < 5:
            colors.append("rgba(39,174,96,0.7)")    # core = green
            border_colors.append("#27ae60")
        else:
            colors.append("rgba(241,196,15,0.7)")    # side = yellow
            border_colors.append("#f1c40f")
    
    fig = go.Figure(data=[go.Bar(
        x=[f"C{c}" for c in cluster_labels],
        y=cluster_data,
        marker=dict(color=colors, line=dict(color=border_colors, width=1)),
        name="Picks per run (aggregated)",
    )])
    
    fig.update_layout(
        title="LR Cluster Coverage (Green=Core, Yellow=Side)",
        showlegend=False,
        yaxis=dict(title="Picks", rangemode="tozero"),
        xaxis=dict(title="Cluster (0-4=Core, 5+=Side)"),
        margin=dict(l=50, r=20, t=60, b=50),
        template="plotly_white",
        height=350,
    )
    
    return _fig_to_html(fig)


def create_age_histograms(desk_age_hist_data: Dict, 
                          engine_colors: Dict = ENGINE_COLORS,
                          engine_ids: Dict = ENGINE_IDS) -> Dict[str, str]:
    """
    Create subplot figure with age histograms for each desk × engine combination.
    Returns dict mapping 'desk_engine' to HTML div.
    """
    charts = {}
    
    for desk in ("primary", "science"):
        for engine in ("keyword", "lr"):
            hist = desk_age_hist_data.get(engine, {}).get(desk)
            if not hist:
                continue
            
            fig = go.Figure(data=[go.Bar(
                x=hist.get("labels", HIST_LABELS),
                y=hist.get("counts", [0]*7),
                marker=dict(
                    color=engine_colors[engine]["light"],
                    line=dict(color=engine_colors[engine]["dark"], width=1),
                ),
                name=f"{engine_ids[engine]} picks",
            )])
            
            fig.update_layout(
                title=f"{desk.capitalize()} Desk - {engine_ids[engine]} Age Histogram",
                showlegend=False,
                yaxis=dict(title="Picks", rangemode="tozero"),
                xaxis=dict(title="Age (days)"),
                margin=dict(l=50, r=20, t=50, b=50),
                template="plotly_white",
                height=250,
            )
            
            key = f"{desk}_{engine}"
            charts[key] = _fig_to_html(fig)
    
    return charts


def create_combined_age_histograms(desk_age_hist_data: Dict,
                                    engine_colors: Dict = ENGINE_COLORS,
                                    engine_ids: Dict = ENGINE_IDS) -> str:
    """
    Create a single subplot figure with all age histograms (2 desks × 2 engines = 4 subplots).
    Returns HTML div for the combined figure.
    """
    # Count how many histograms we have
    subplot_titles = []
    subplot_data = []
    
    for desk in ("primary", "science"):
        for engine in ("keyword", "lr"):
            hist = desk_age_hist_data.get(engine, {}).get(desk)
            if hist:
                subplot_titles.append(f"{desk.capitalize()} - {engine_ids[engine]}")
                subplot_data.append((desk, engine, hist))
    
    if not subplot_data:
        return ""
    
    # Create subplots: 2 rows (desks) × 2 cols (engines)
    fig = make_subplots(
        rows=2, cols=2,
        subplot_titles=subplot_titles,
        vertical_spacing=0.15,
        horizontal_spacing=0.1,
    )
    
    row_map = {"primary": 1, "science": 2}
    col_map = {"keyword": 1, "lr": 2}
    
    for desk, engine, hist in subplot_data:
        row = row_map[desk]
        col = col_map[engine]
        
        fig.add_trace(go.Bar(
            x=hist.get("labels", HIST_LABELS),
            y=hist.get("counts", [0]*7),
            marker=dict(
                color=engine_colors[engine]["light"],
                line=dict(color=engine_colors[engine]["dark"], width=1),
            ),
            name=f"{engine_ids[engine]}",
            showlegend=(row == 1 and col == 1),  # Only show legend once
        ), row=row, col=col)
        
        fig.update_xaxes(title_text="Age (days)", row=row, col=col)
        fig.update_yaxes(title_text="Picks", rangemode="tozero", row=row, col=col)
    
    fig.update_layout(
        title="Age Histograms by Desk and Engine",
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=50, r=20, t=80, b=50),
        template="plotly_white",
        height=500,
    )
    
    return _fig_to_html(fig)