"""Hacker News feed fetcher (migrated out of fetcher.py).

Hacker News exposes an RSS feed (https://news.ycombinator.com/rss), so HN
sources are configured with ``kind: "rss`` and fetched through the generic
:func:`fetch_rss`.  This module keeps the legacy Algolia-based
:func:`fetch_hn` for reference / reuse, but it is no longer registered in the
``FETCHERS`` registry -- there are only two feed types, ``"api"`` and
``"rss"``.
"""

from __future__ import annotations

import json
import math
import time
import urllib.parse

from fetch.fetcher import Fetcher, make_item, canonical_url, parse_date, strip_html


def fetch_hn(f: Fetcher, spec: dict) -> list[dict]:
    """Fetch HN story search via the Algolia API (legacy, not registered).

    Kept here so fetcher.py stays free of HN-specific code.  Not wired into
    ``FETCHERS`` because HN is now an RSS feed.
    """
    since = int(time.time() - f.cfg["hn_lookback_days"] * 86400)
    qs = urllib.parse.urlencode({
        "query": spec["query"], "tags": "story", "hitsPerPage": 30,
        "numericFilters": f"created_at_i>{since},points>{spec['min_points']}",
    })
    data = json.loads(f.get(f"https://hn.algolia.com/api/v1/search_by_date?{qs}"))
    out = []
    for h in data.get("hits", []):
        url = h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}"
        pts = h.get("points") or 1
        snippet = strip_html(h.get("story_text") or "") or (
            f"Hacker News discussion: {pts} points, {h.get('num_comments', 0)} comments.")
        boost = min(1.0, max(0.6, 0.6 + 0.2 * math.log10(max(pts, 1))))
        out.append(make_item(url, h.get("title", ""), snippet, parse_date(h.get("created_at")),
                             "Hacker News", spec["subtopic"], spec["weight"], boost,
                             spec.get("type", "commentary"), authors=[]))
    return out
