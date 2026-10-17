"""Semantic Scholar Graph API source fetcher.

``SemanticScholarFetcher`` simply inherits from the abstract ``Fetcher`` base
class in fetcher.py and reuses its cached HTTP GET and generic (optional)
throttler.  The module also keeps the legacy ``fetch_semanticscholar(f, spec)``
function API used by the ``FETCHERS`` registry.
"""
from __future__ import annotations

import json
import urllib.parse

from fetcher import Fetcher, make_item, canonical_url, parse_date, strip_html
from util import log, warn


class SemanticScholarFetcher(Fetcher):
    """Fetcher for https://api.semanticscholar.org/graph/v1 .

    Inherits :meth:`Fetcher.get` (cached HTTP GET) and
    :meth:`Fetcher.semanticscholar_throttle` (generic Throttler-backed delay).
    """

    def fetch(self, spec: dict) -> list[dict]:
        """Fetch one Semantic Scholar feed spec and return normalised items."""
        self.semanticscholar_throttle()
        return _s2_items(self, spec)


def _s2_endpoint(spec: dict) -> str:
    limit = spec.get("limit", 12)
    params = urllib.parse.urlencode({
        "query": spec["query"],
        "limit": limit,
        "fields": (
            "title,abstract,url,publicationDate,"
            "year,externalIds"
        ),
    })
    return "https://api.semanticscholar.org/graph/v1/paper/search?" + params


def _s2_items(f: Fetcher, spec: dict) -> list[dict]:
    data = json.loads(f.get(_s2_endpoint(spec)))
    out = []
    for item in data.get("data", []):
        title = item.get("title", "")
        if not title:
            continue

        ids = item.get("externalIds") or {}
        arxiv_id = ids.get("ArXiv")

        if arxiv_id:
            url = f"https://arxiv.org/abs/{arxiv_id}"
        else:
            url = item.get("url") or (
                "https://www.semanticscholar.org/paper/"
                f"{item.get('paperId')}"
            )

        date = parse_date(
            item.get("publicationDate")
            or str(item.get("year", ""))
        )

        out.append(make_item(
            url,
            title,
            item.get("abstract") or "",
            date,
            "Semantic Scholar",
            spec["subtopic"],
            spec["weight"],
            source_type=spec.get("type", "researchlike"),
        ))

    return out


def fetch_semanticscholar(f: Fetcher, spec: dict) -> list[dict]:
    """Registry-compatible function API: throttle then fetch via any Fetcher."""
    f.semanticscholar_throttle()
    return _s2_items(f, spec)


def refresh_semanticscholar(cfg: dict, src: dict) -> None:
    """Background refresh of every Semantic Scholar feed (``--refresh-s2``)."""
    fetcher = Fetcher(cfg["fetch"])
    for specs in src.get("feeds", {}).values():
        for spec in specs:
            if spec.get("kind") != "semanticscholar":
                continue
            try:
                items = fetch_semanticscholar(fetcher, spec)
                log(f"Semantic Scholar refreshed {spec['name']}: {len(items)} items")
            except Exception as e:
                warn(f"Semantic Scholar source {spec['name']} failed ({type(e).__name__}: {e})")
    log("Semantic Scholar background refresh complete")
