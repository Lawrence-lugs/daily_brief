"""Semantic Scholar Graph API source fetcher.

``SemanticScholarFetcher`` inherits from the generic ``Fetcher`` base class in
``fetch/fetcher.py`` and reuses its cached HTTP GET and generic throttler.
The module also registers :func:`fetch_semanticscholar` as the ``"api"``
fetcher for ``"semanticscholar"`` sources via :func:`fetch.register_api_fetcher`,
so it is picked up by the background ``--refresh-api-feeds`` refresh.

Nothing in fetcher.py is Semantic Scholar specific anymore.
"""
from __future__ import annotations

import json
import urllib.parse

from fetch.fetcher import Fetcher, make_item, canonical_url, parse_date, strip_html, register_api_fetcher
from util import log, warn


class SemanticScholarFetcher(Fetcher):
    """Fetcher for https://api.semanticscholar.org/graph/v1 .

    Inherits :meth:`Fetcher.get` (cached HTTP GET) and
    :meth:`Fetcher.throttle` (generic Throttler-backed delay).
    """

    def fetch(self, spec: dict) -> list[dict]:
        """Fetch one Semantic Scholar feed spec and return normalised items."""
        self.throttle()
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
    f.throttle()
    return _s2_items(f, spec)


# Register as the "api" fetcher so the background --refresh-api-feeds refresh
# can dispatch to it generically (keyed by the spec's "fetcher" field or
# source name).
register_api_fetcher("semanticscholar", fetch_semanticscholar)
