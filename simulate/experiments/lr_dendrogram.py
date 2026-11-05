"""Plot a Ward-clustering dendrogram for the LR model's interests at a given date.

The dendrogram shows the hierarchical (Ward) clustering of the interest vectors
that the LR model builds from:

* perfect samples (``perfect_samples.json``, weight = ``kappa``)
* liked / saved stories (weight = 1)

This is the same clustering produced by ``ranker/agglo.js`` (``wardCut``) that
drives the LR engine's core / side cluster round-robin. The plot mirrors the JS
buildInputs / buildInterests inputs for the requested date so the dendrogram
reflects the *current configuration* of the LR model.

Usage (from the project root)::

    python simulate/experiments/lr_dendrogram.py                    # latest pool date
    python simulate/experiments/lr_dendrogram.py --date 2026-11-01
    python simulate/experiments/lr_dendrogram.py --date 2026-11-01 \\
        --embedding-model bge-micro --output-dir docs/experiments

Outputs a PNG figure and a JSON sidecar to ``docs/experiments/`` by default.

Requires the embeddings for the configured model to already exist in
``daily_brief.db`` (run ``node ranker/cli.js embed`` if missing).
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
from scipy.cluster.hierarchy import dendrogram, linkage as ward_linkage

# Force a non-interactive backend before importing pyplot.
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[2]  # simulate/experiments -> project root
CONFIG_PATH = PROJECT_ROOT / "config.json"
DB_PATH = PROJECT_ROOT / "daily_brief.db"
PERFECT_PATH = PROJECT_ROOT / "perfect_samples.json"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "docs" / "experiments"
TEMPLATE_DIR = PROJECT_ROOT / "simulate" / "experiments" / "templates"

CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>'

# Leaf colours by interest type.
CORE_COLOR = "#1f6fb2"        # core perfect sample
PERFECT_COLOR = "#7fa6e2"     # non-core perfect sample
LIKED_COLOR = "#52a852"       # liked / saved story
LINK_COLOR = "#4d4d4d"
CUT_COLOR = "#c0392b"


def load_config() -> dict[str, Any]:
    """Load ``config.json`` and return the ``ranker`` section."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    return cfg.get("ranker", {})


def embedding_model_tag(ranker_cfg: dict[str, Any], override: str | None, conn: sqlite3.Connection) -> str:
    """Resolve the embedding model tag stored in ``embeddings.model``.

    ``config.json`` stores the registry key (e.g. ``leaf-mt``) while the DB stores
    ``<key>:<dtype>`` (e.g. ``leaf-mt:fp32``). Match by key prefix, preferring
    ``:fp32`` when several dtypes exist.
    """
    model = override or (ranker_cfg.get("embedding", {}) or {}).get("model", "leaf-mt")
    candidates = [r[0] for r in conn.execute("SELECT DISTINCT model FROM embeddings")]
    matches = [m for m in candidates if m.split(":")[0] == model]
    if not matches:
        raise SystemExit(
            f"No embeddings found for model '{model}'. Available: {candidates}. "
            f"Run `node ranker/cli.js embed` first."
        )
    # Prefer fp32 dtype, then the first match.
    for dtype in ("fp32", "q8"):
        for m in matches:
            if m.endswith(f":{dtype}"):
                return m
    return matches[0]


def latest_date(conn: sqlite3.Connection) -> str:
    """Return the latest pool/brief date (YYYY-MM-DD)."""
    row = conn.execute("SELECT MAX(date) FROM briefs").fetchone()
    d = row[0] if row and row[0] else None
    if not d:
        row = conn.execute("SELECT MAX(published) FROM candidate_pool").fetchone()
        d = (row[0] or "")[:10] if row and row[0] else None
    if not d:
        raise SystemExit("No dates found in the database.")
    return d


def load_embeddings(conn: sqlite3.Connection, model_tag: str) -> dict[str, np.ndarray]:
    """Load all embeddings for ``model_tag`` as L2-normalised float64 vectors."""
    emb: dict[str, np.ndarray] = {}
    for item_id, _model, _dim, vec_blob in conn.execute(
        "SELECT item_id, model, dim, vec FROM embeddings WHERE model=?", (model_tag,)
    ):
        v = np.frombuffer(bytes(vec_blob), dtype=np.float32).astype(np.float64)
        n = float(np.linalg.norm(v))
        if n > 0:
            v = v / n
        emb[item_id] = v
    return emb


def load_interest_points(
    conn: sqlite3.Connection,
    date: str,
    model_tag: str,
    ranker_cfg: dict[str, Any],
    emb: dict[str, np.ndarray],
) -> list[dict[str, Any]]:
    """Build the interest points (mirrors ``ranker/interests.js`` buildInterests).

    Returns a list of dicts with keys: id, title, vec, kind, core,
    representative, weight.
    """
    interests_cfg = ranker_cfg.get("interests", {}) or {}
    kappa = float(interests_cfg.get("kappa", 5))
    max_liked_days = int(interests_cfg.get("maxLikedDays", 1000))

    # --- perfect samples ---
    with open(PERFECT_PATH, "r", encoding="utf-8") as fh:
        perfect_samples = json.load(fh)

    points: list[dict[str, Any]] = []
    seen: set[str] = set()

    for ps in perfect_samples:
        pid = ps["id"]
        db_id = pid if pid.startswith("ps:") else f"ps:{pid}"
        if db_id not in emb:
            print(f"  warning: perfect sample {db_id} has no embedding, skipping")
            continue
        points.append(
            {
                "id": db_id,
                "title": ps.get("title", db_id),
                "vec": emb[db_id],
                "kind": "perfect",
                "core": bool(ps.get("core", False)),
                "representative": ps.get("representative", True),
                "weight": kappa,
            }
        )
        seen.add(db_id)

    # --- liked / saved stories (within maxLikedDays of the date) ---
    cutoff = (datetime.fromisoformat(date).replace(tzinfo=timezone.utc) - timedelta(days=max_liked_days)).date().isoformat()
    pool_titles = {r[0]: r[1] for r in conn.execute("SELECT item_id, title FROM candidate_pool")}
    story_titles = {r[0]: r[1] for r in conn.execute("SELECT item_id, headline FROM stories")}
    liked_rows = conn.execute(
        """
        SELECT s.item_id, s.headline, MIN(b.date) AS liked_date
        FROM stories s JOIN briefs b ON b.brief_id = s.brief_id
        WHERE (s.liked = 1 OR s.saved = 1) AND b.date >= ?
        GROUP BY s.item_id
        """,
        (cutoff,),
    ).fetchall()

    for item_id, headline, _liked_date in liked_rows:
        if item_id in seen:
            continue
        if item_id not in emb:
            continue
        title = pool_titles.get(item_id) or story_titles.get(item_id) or headline or item_id
        points.append(
            {
                "id": item_id,
                "title": title,
                "vec": emb[item_id],
                "kind": "liked",
                "core": False,
                "representative": False,
                "weight": 1.0,
            }
        )
        seen.add(item_id)

    if not points:
        raise SystemExit("No interest points with embeddings found; cannot build dendrogram.")
    return points


def ward_cut(
    X: np.ndarray,
    representative: set[int],
    mode: str = "constrained",
    min_clusters: int = 1,
    max_height: float = math.inf,
) -> tuple[list[list[int]], float | None, list[float]]:
    """Python mirror of ``ranker/agglo.js`` wardCut.

    Returns (clusters, stop_height, heights) using squared-Euclidean Ward
    distances (same scale as the JS implementation).
    """
    n = X.shape[0]
    D = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            d = float(np.sum((X[i] - X[j]) ** 2))
            D[i, j] = D[j, i] = d

    size = np.ones(n, dtype=np.float64)
    active = np.ones(n, dtype=bool)
    nrep = np.zeros(n, dtype=np.int64)
    for i in representative:
        nrep[i] = 1
    members = [[i] for i in range(n)]
    alive = n
    stop_height: float | None = None
    heights: list[float] = []

    while alive > max(1, min_clusters):
        best = math.inf
        bi = bj = -1
        for i in range(n):
            if not active[i]:
                continue
            for j in range(i + 1, n):
                if not active[j]:
                    continue
                if mode == "constrained" and nrep[i] and nrep[j]:
                    continue
                if D[i, j] < best:
                    best = D[i, j]
                    bi, bj = i, j
        if bi < 0:
            break
        if best > max_height:
            stop_height = best
            break
        if mode == "stop" and nrep[bi] and nrep[bj]:
            stop_height = best
            break
        ni, nj = size[bi], size[bj]
        for k in range(n):
            if not active[k] or k == bi or k == bj:
                continue
            nk = size[k]
            tot = ni + nj + nk
            d = ((ni + nk) * D[bi, k] + (nj + nk) * D[bj, k] - nk * best) / tot
            D[bi, k] = D[k, bi] = d
        size[bi] = ni + nj
        nrep[bi] += nrep[bj]
        members[bi] = members[bi] + members[bj]
        active[bj] = False
        alive -= 1
        heights.append(best)

    clusters = [members[i] for i in range(n) if active[i]]
    return clusters, stop_height, heights


def weighted_medoid(X: np.ndarray, weights: np.ndarray, idx: list[int]) -> int:
    """Index (within the full point set) of the weighted medoid of a cluster."""
    c = np.zeros(X.shape[1])
    W = 0.0
    for i in idx:
        c += weights[i] * X[i]
        W += weights[i]
    if W == 0:
        return idx[0]
    c = c / W
    best = idx[0]
    bd = float(np.sum((X[idx[0]] - c) ** 2))
    for i in idx[1:]:
        d = float(np.sum((X[i] - c) ** 2))
        if d < bd:
            bd = d
            best = i
    return best


def build_plot_inputs(points: list[dict[str, Any]]):
    """Return (X, leaf order arrays) ready for linkage + dendrogram."""
    X = np.stack([p["vec"] for p in points]).astype(np.float64)
    # Re-normalise defensively (embeddings are already unit-norm).
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    X = X / norms
    representative = {i for i, p in enumerate(points) if p["representative"]}
    weights = np.array([p["weight"] for p in points], dtype=np.float64)
    return X, representative, weights


def chartjs_tag(chartjs: Path | None) -> str:
    """`<script>` tag loading Chart.js: a local file inlined, or the CDN."""
    if chartjs is not None:
        lib = Path(chartjs).read_text(encoding="utf-8").replace("</script", "<\\/script")
        return f"<script>{lib}</script>"
    return CDN_TAG


def _js_block(name: str, **replacements: str) -> str:
    """Read a JS template file, substitute placeholders, wrap in a <script> tag."""
    js = (TEMPLATE_DIR / name).read_text(encoding="utf-8")
    for key, value in replacements.items():
        js = js.replace(key, value)
    return f"<script>{js.replace('</script', '<\\/script')}</script>"


def pca2(X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """2-D PCA via SVD. Returns (Z, explained_variance_ratio)."""
    Xc = X - X.mean(axis=0, keepdims=True)
    _, s, vt = np.linalg.svd(Xc, full_matrices=False)
    Z = Xc @ vt[:2].T
    ev = (s[:2] ** 2) / (s ** 2).sum()
    return Z, ev


def build_payload(
    points: list[dict[str, Any]],
    X: np.ndarray,
    labels: list[int],
    clusters_meta: list[dict[str, Any]],
    linkage: list[list],
    stop_height_scipy: float | None,
    date: str,
    model_tag: str,
) -> str:
    """Build the JSON data payload embedded in the HTML report."""
    Z, ev = pca2(X)
    n = len(points)

    # Cluster assignment -> list of point indices.
    members_by_cluster: dict[int, list[int]] = {}
    for i, cid in enumerate(labels):
        members_by_cluster.setdefault(cid, []).append(i)

    clusters_out: list[dict[str, Any]] = []
    for cm in clusters_meta:
        cid = cm["id"]
        idx = members_by_cluster.get(cid, [])
        pts = [
            {
                "x": round(float(Z[i][0]), 5),
                "y": round(float(Z[i][1]), 5),
                "path": points[i]["id"],
                "title": points[i]["title"],
                "kind": points[i]["kind"],
                "core": points[i]["core"],
            }
            for i in idx
        ]
        if pts:
            cx = float(np.mean([p["x"] for p in pts]))
            cy = float(np.mean([p["y"] for p in pts]))
        else:
            cx = cy = 0.0
        clusters_out.append(
            {
                "id": cid,
                "n": len(idx),
                "cx": round(cx, 5),
                "cy": round(cy, 5),
                "points": pts,
                "nearest": [cm.get("medoid_title", cm.get("medoid", ""))],
            }
        )

    data = {
        "vault": "LR model",
        "subtitle": f"date={date}  \u00b7  embedding={model_tag}  \u00b7  "
                    f"{n} interest points  \u00b7  Ward clustering (ranker/agglo.js)",
        "xlabel": f"PC1 ({ev[0]:.1%} of variance)",
        "ylabel": f"PC2 ({ev[1]:.1%} of variance)",
        "keys": [p["id"] for p in points],
        "clusters": clusters_out,
        "linkage": linkage,
        "stop_height": stop_height_scipy,
        "n_points": n,
    }
    return json.dumps(data).replace("</", "<\\/")


def write_html(
    out: Path,
    title: str,
    subtitle: str,
    payload: str,
    chartjs: Path | None = None,
    template: str = "dendrogram.html",
    scripts: tuple[str, ...] = ("scatter.js", "dendrogram.js"),
) -> None:
    """Write the self-contained HTML report (scatter + dendrogram views)."""
    scripts_html = "".join(_js_block(name, __DATA__=payload) for name in scripts)
    html = (
        (TEMPLATE_DIR / template).read_text(encoding="utf-8")
        .replace("__TITLE__", title)
        .replace("__CHARTJS__", chartjs_tag(chartjs))
        .replace("__SCRIPTS__", scripts_html)
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")


def plot_dendrogram(
    Z_plot: np.ndarray,
    points: list[dict[str, Any]],
    stop_height: float | None,
    out_path: Path,
    figsize: tuple[float, float],
    leaf_font_size: int,
    dpi: int,
    draw_cut_line: bool,
) -> dict[str, Any]:
    """Render the Ward dendrogram to ``out_path``."""
    n = len(points)
    leaf_labels: list[str] = []
    leaf_colors: list[str] = []
    for p in points:
        title = p["title"]
        short = (title[:42] + "\u2026") if len(title) > 42 else title
        label = f"{p['id']}  {short}"
        leaf_labels.append(label)
        if p["kind"] == "perfect":
            leaf_colors.append(CORE_COLOR if p["core"] else PERFECT_COLOR)
        else:
            leaf_colors.append(LIKED_COLOR)

    fig, ax = plt.subplots(figsize=figsize, dpi=dpi)
    dend = dendrogram(
        Z_plot,
        labels=leaf_labels,
        leaf_rotation=90,
        leaf_font_size=leaf_font_size,
        color_threshold=0,
        above_threshold_color=LINK_COLOR,
        ax=ax,
    )

    # Colour each leaf label by interest type.
    for i, leaf_idx in enumerate(dend["leaves"]):
        lbl = ax.get_xticklabels()[i]
        lbl.set_color(leaf_colors[leaf_idx])
        lbl.set_fontweight("bold" if points[leaf_idx]["core"] else "normal")

    if draw_cut_line and stop_height is not None:
        ax.axhline(stop_height, color=CUT_COLOR, linestyle="--", linewidth=1.6,
                   label=f"model cut height = {stop_height:.4f}")
        ax.legend(loc="upper right", fontsize=8)

    n_core = sum(1 for p in points if p["kind"] == "perfect" and p["core"])
    n_perf = sum(1 for p in points if p["kind"] == "perfect")
    n_liked = sum(1 for p in points if p["kind"] == "liked")
    ax.set_xlabel("Interest (leaf = perfect sample or liked/saved story)")
    ax.set_ylabel("Ward distance (squared-Euclidean, ranker/agglo.js scale)")
    ax.set_title(
        f"LR clustering dendrogram  |  {n_core} core / {n_perf - n_core} side perfect / "
        f"{n_liked} liked  |  n = {n}"
    )
    fig.tight_layout()
    fig.savefig(out_path, dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    return dend


def run(
    date: str | None,
    embedding_model: str | None,
    output_dir: Path,
    fig_size: tuple[float, float],
    leaf_font_size: int,
    dpi: int,
    draw_cut_line: bool,
    emit_html: bool = True,
    chartjs: str | None = None,
) -> dict[str, Any]:
    """Build and plot the LR clustering dendrogram. Returns the result metadata."""
    ranker_cfg = load_config()

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        model_tag = embedding_model_tag(ranker_cfg, embedding_model, conn)
        date = date or latest_date(conn)
        emb = load_embeddings(conn, model_tag)
        points = load_interest_points(conn, date, model_tag, ranker_cfg, emb)
    finally:
        conn.close()

    X, representative, weights = build_plot_inputs(points)
    interests_cfg = ranker_cfg.get("interests", {}) or {}
    mode = interests_cfg.get("mode", "constrained")
    min_clusters = int(interests_cfg.get("minClusters", 1))

    # Model's actual cut height (mirrors JS wardCut stopping rule).
    clusters, stop_height, _heights = ward_cut(X, representative, mode=mode, min_clusters=min_clusters)
    stop_height_scipy = stop_height / 2.0 if stop_height is not None else None

    # Leaf -> cluster id labels, mirroring build_interests output.
    labels = [0] * len(points)
    for cid, idx in enumerate(clusters):
        for i in idx:
            labels[i] = cid

    # Cluster metadata for the model's cut (mirrors build_interests output).
    cluster_meta: list[dict[str, Any]] = []
    for cid, idx in enumerate(clusters):
        w = weights[list(idx)]
        medoid_idx = weighted_medoid(X, weights, list(idx))
        cluster_meta.append(
            {
                "id": cid,
                "medoid": points[medoid_idx]["id"],
                "medoid_title": points[medoid_idx]["title"],
                "size": len(idx),
                "core": any(points[i]["kind"] == "perfect" and points[i]["core"] for i in idx),
                "members": [points[i]["id"] for i in sorted(idx)],
            }
        )

    # Full Ward hierarchy for the dendrogram. scipy's ward heights are half the
    # squared-Euclidean Ward distance used by ranker/agglo.js, so rescale column 2
    # to the JS scale so the cut line aligns with the height axis.
    Z = ward_linkage(X, method="ward", metric="euclidean")
    Z_plot = Z.copy()
    Z_plot[:, 2] *= 2.0
    linkage = [[int(a), int(b), float(d), int(sz)] for a, b, d, sz in Z]

    output_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    png_name = f"lr_dendrogram_{date}_{ts}.png"
    json_name = f"lr_dendrogram_{date}_{ts}.json"
    png_path = output_dir / png_name
    json_path = output_dir / json_name

    dend = plot_dendrogram(
        Z_plot, points, stop_height, png_path, fig_size, leaf_font_size, dpi, draw_cut_line
    )

    # Build the interactive HTML report (scatter + dendrogram views), mirroring
    # the clustering package output at clustering/src/clustering.
    html_path = None
    if emit_html:
        html_name = f"lr_dendrogram_{date}_{ts}.html"
        html_path = output_dir / html_name
        payload = build_payload(
            points, X, labels, cluster_meta, linkage, stop_height_scipy, date, model_tag
        )
        write_html(
            html_path,
            title=f"LR clustering dendrogram — {date}",
            subtitle="",
            payload=payload,
            chartjs=Path(chartjs) if chartjs else None,
        )

    result = {
        "date": date,
        "embedding_model": embedding_model,
        "model_tag": model_tag,
        "n_points": len(points),
        "n_core_perfect": sum(1 for p in points if p["kind"] == "perfect" and p["core"]),
        "n_side_perfect": sum(1 for p in points if p["kind"] == "perfect" and not p["core"]),
        "n_liked": sum(1 for p in points if p["kind"] == "liked"),
        "kappa": float(interests_cfg.get("kappa", 5)),
        "max_liked_days": int(interests_cfg.get("maxLikedDays", 1000)),
        "mode": mode,
        "min_clusters": min_clusters,
        "stop_height": stop_height,
        "stop_height_scipy": stop_height_scipy,
        "n_clusters": len(cluster_meta),
        "clusters": cluster_meta,
        "png": str(png_path),
        "json": str(json_path),
        "html": str(html_path) if html_path else None,
        "timestamp": datetime.now().isoformat(),
    }
    json_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(f"Dendrogram PNG written to {png_path}")
    if html_path:
        print(f"HTML report written to    {html_path}")
    print(f"Metadata written to       {json_path}")
    print(f"  points={result['n_points']} "
          f"(core={result['n_core_perfect']}, side={result['n_side_perfect']}, liked={result['n_liked']}) "
          f"clusters={result['n_clusters']} stop_height={stop_height}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Plot the LR model's clustering dendrogram at a given date."
    )
    parser.add_argument("--date", default=None, help="Pool date YYYY-MM-DD (default: latest)")
    parser.add_argument(
        "--embedding-model", default=None, help="Embedding model key (default: config.json ranker.embedding.model)"
    )
    parser.add_argument(
        "--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Output directory for PNG + JSON"
    )
    parser.add_argument(
        "--fig-size", default="16,9", help='Figure size as "width,height" in inches (default: 16,9)'
    )
    parser.add_argument("--leaf-font-size", type=int, default=7, help="Leaf label font size (default: 7)")
    parser.add_argument("--dpi", type=int, default=150, help="Figure DPI (default: 150)")
    parser.add_argument(
        "--no-cut-line", action="store_true", help="Do not draw the model cut-height line"
    )
    parser.add_argument(
        "--no-html", action="store_true", help="Skip writing the interactive HTML report"
    )
    parser.add_argument(
        "--chartjs", default=None, help="Path to a local chart.umd.js to inline (default: load from CDN)"
    )
    args = parser.parse_args()

    try:
        fig_size = tuple(float(x) for x in args.fig_size.split(","))
        if len(fig_size) != 2:
            raise ValueError
    except ValueError:
        print(f"Error: --fig-size must be 'width,height', got '{args.fig_size}'")
        return 1

    run(
        date=args.date,
        embedding_model=args.embedding_model,
        output_dir=Path(args.output_dir),
        fig_size=fig_size,
        leaf_font_size=args.leaf_font_size,
        dpi=args.dpi,
        draw_cut_line=not args.no_cut_line,
        emit_html=not args.no_html,
        chartjs=args.chartjs,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
