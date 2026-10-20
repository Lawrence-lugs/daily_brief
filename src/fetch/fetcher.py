"""Fetching subsystem (stdlib only).

Provides:
    Throttler          generic, optional rate throttle (min interval between calls)
    Fetcher            abstract base class: cached HTTP GET + optional throttler
    strip_html         HTML -> plain text helper
    parse_date         flexible HTTP/ISO date parser -> UTC datetime
    canonical_url      URL normalisation (arXiv, utm_/tracking params, etc.)
    make_item          normalised item dict factory
    parse_feed         RSS/Atom parser
    fetch_rss          generic RSS fetcher
    FETCHERS           kind -> fetch function registry (``"rss"`` only)
    register_api_fetcher  register a fetcher for ``"api"`` feeds
    refresh_api_feeds     fetch every ``"api"`` feed (background refresh)
    fetch_all          parallel fan-out over sources.json specs; ``"api"`` feeds
                       are skipped here and refreshed in the background

Source-specific fetchers live in their own files under ``src/fetch/`` (e.g.
semanticscholar.py, hn.py) and simply inherit from ``Fetcher``.  Throttling is
generic (Throttler) and optional (``api_delay_s`` <= 0 disables it).

``sources.json`` groups feeds under exactly two types: ``"api"`` (throttled
API fetches that run as a detached background refresh) and ``"rss"`` (fetched
in parallel in the main program).  Each feed spec declares a ``kind`` of
``"api"`` or ``"rss"``.
"""
from __future__ import annotations

import datetime as dt
import html
import concurrent.futures as cf
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

import util

HERE = Path(__file__).resolve().parent
UTC = dt.timezone.utc


def _cache_dir() -> Path:
    """Resolve the cache directory.

    The cache path is owned by brief (:data:`brief.CACHE`); its test conftest
    monkeypatches ``brief.CACHE`` to a temp dir, so resolve it lazily here so
    the redirect takes effect in :class:`Fetcher`.
    """
    from brief import CACHE

    return CACHE


class Throttler:
    """Generic optional throttle.

    Guarantees at least ``min_interval_s`` seconds elapse between calls to
    ``wait``.  A zero or negative interval disables throttling entirely.
    Safe for concurrent use.
    """

    def __init__(self, min_interval_s: float = 0.0):
        self.min_interval = float(min_interval_s)
        self._last = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            wait = self._last + self.min_interval - time.time()
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()


class Fetcher:
    """Abstract base class for feed fetchers.

    Source-specific fetchers (semanticscholar.py, ...) subclass this and
    implement :meth:`fetch`.  This base provides a cached HTTP GET
    (:meth:`get`) and an optional, generic throttler (:meth:`throttle`).
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._throttle = Throttler(cfg.get("api_delay_s", 0.0))
        self._cache_dir = _cache_dir()
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    def get(self, url: str, use_cache: bool = True, headers: dict | None = None) -> str:
        cache_file = self._cache_dir / (hashlib.sha1(url.encode()).hexdigest() + ".txt")
        ttl = self.cfg["cache_ttl_hours"] * 3600
        if use_cache and cache_file.exists() and time.time() - cache_file.stat().st_mtime < ttl:
            return cache_file.read_text(encoding="utf-8")
        req = urllib.request.Request(
            url, headers={"User-Agent": self.cfg["user_agent"], **(headers or {})}
        )
        with urllib.request.urlopen(req, timeout=self.cfg["timeout_s"]) as r:
            raw = r.read()
        text = raw.decode("utf-8", errors="replace")
        cache_file.write_text(text, encoding="utf-8")
        return text

    def throttle(self) -> None:
        """Enforce the generic API delay between calls."""
        self._throttle.wait()


def strip_html(s: str) -> str:
    s = re.sub(r"<(script|style).*?</\1>", " ", s or "", flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def parse_date(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d.astimezone(UTC)


def canonical_url(url: str) -> str:
    u = urllib.parse.urlsplit(url.strip())
    m = re.match(r"^/(?:abs|pdf)/(.+?)(?:v\d+)?(?:\.pdf)?$", u.path)
    if u.netloc.endswith("arxiv.org") and m:
        return f"https://arxiv.org/abs/{m.group(1)}"
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query)
         if not k.lower().startswith(("utm_", "fbclid", "ref", "source"))]
    path = u.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((u.scheme or "https", u.netloc.lower(), path,
                                    urllib.parse.urlencode(q), ""))


def make_item(
    url, title, snippet, published, source, hint_sub, weight, extra_rel=1.0,
    source_type="researchlike",
):
    url = canonical_url(url)
    return {
        "id": hashlib.sha1(url.encode()).hexdigest()[:12],
        "url": url,
        "title": re.sub(r"\s+", " ", title or "").strip(),
        "snippet": (snippet or "").strip()[:900],
        "published": published.isoformat() if published else None,
        "source": source,
        "source_type": source_type,
        "hint": hint_sub,
        "weight": weight * extra_rel,
    }


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_feed(
    xml_text: str, name: str, weight: float, hint: str | None,
    source_type: str = "researchlike",
) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for node in root.iter():
        if local(node.tag) not in ("item", "entry"):
            continue
        f: dict[str, str] = {}
        link = ""
        for ch in node:
            t = local(ch.tag)
            if t == "link":
                link = link or ch.get("href") or (ch.text or "")
            elif t in ("title", "description", "summary", "content", "encoded",
                       "pubDate", "published", "updated", "date"):
                f.setdefault(t, ch.text or "")
        title = strip_html(f.get("title", ""))
        body = strip_html(f.get("encoded") or f.get("content") or f.get("description") or f.get("summary") or "")
        date = parse_date(f.get("pubDate") or f.get("published") or f.get("updated") or f.get("date"))
        if title and link.startswith("http"):
            out.append(make_item(link, title, body, date, name, hint, weight,
                                 source_type=source_type))
    return out


def fetch_rss(f: Fetcher, spec: dict) -> list[dict]:
    return parse_feed(
        f.get(spec["url"]), spec["name"], spec["weight"], spec["default_subtopic"],
        spec.get("type", "newslike"),
    )


# --------------------------------------------------------------------------- feed registry

# How to turn a feed spec into fetched items. Each source in sources.json
# declares a "kind" that selects the fetch routine, so nothing here is
# keyed to a particular feed name.  Only two kinds exist: "rss" (fetched in
# parallel in the main program) and "api" (refreshed in the background).
FETCHERS: dict[str, callable] = {
    "rss": fetch_rss,
}

# Registry of fetchers for ``"api"`` feeds, keyed by name.  Source-specific
# fetchers register themselves here (e.g. semanticscholar.py registers
# ``"semanticscholar"``).  Kept separate from FETCHERS so the main loop never
# accidentally blocks on a throttled API call.
API_FETCHERS: dict[str, callable] = {}


def register_api_fetcher(name: str, fn) -> None:
    """Register a fetch function for an ``"api"`` feed source."""
    API_FETCHERS[name] = fn


def _iter_feed_specs(feeds: dict):
    """Yield every feed spec, regardless of grouping.

    ``feeds`` may group specs either as flat lists (``{"api": [...], "rss": [...]}``)
    or nested by source (``{"api": {"semanticscholar": [...]}, "rss": [...]}``).
    """
    for group in feeds.values():
        if isinstance(group, dict):
            for specs in group.values():
                yield from specs
        else:
            yield from group


def refresh_api_feeds(cfg: dict, src: dict) -> list[dict]:
    """Fetch every ``"api"`` feed and return the raw (unclassified) items.

    Runs in the detached background process (``brief.py --refresh-api-feeds``),
    so the throttled API calls never block the main program. Results can be up
    to about a day old.  Each ``"api"`` spec is dispatched to the fetcher
    registered for it via :func:`register_api_fetcher` (or its ``fetcher``
    field).
    """
    from brief import Fetcher

    f = Fetcher(cfg["fetch"])
    items: list[dict] = []
    for spec in _iter_feed_specs(src.get("feeds", {})):
        if spec.get("kind") != "api":
            continue
        key = spec.get("fetcher") or spec.get("source", "").lower().replace(" ", "_")
        fn = API_FETCHERS.get(key)
        if fn is None:
            util.warn(f"no api fetcher registered for {key!r}; skipping {spec['name']}")
            continue
        try:
            got = fn(f, spec)
            items.extend(got)
            util.log(f"API refreshed {spec['name']}: {len(got)} items")
        except Exception as e:
            util.warn(f"API source {spec['name']} failed ({type(e).__name__}: {e})")
    util.log("API background refresh complete")
    return items


def _start_api_refresh(api_count: int) -> None:
    """Start a detached background process that refreshes all ``"api"`` feeds."""
    brief_py = HERE.parent / "brief.py"
    refresh = [sys.executable, str(brief_py), "--refresh-api-feeds"]
    if util.LOG_FILE:
        refresh.extend(("--log-file", str(util.LOG_FILE)))
    try:
        options = {
            "cwd": str(HERE.parent),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.DETACHED_PROCESS
        subprocess.Popen(refresh, **options)
        util.log(f"API background refresh started ({api_count} queries)")
    except OSError as e:
        util.warn(f"could not start API background refresh ({type(e).__name__}: {e})")


def fetch_all(cfg: dict, src: dict, refresh_api: bool = True) -> list[dict]:
    # Fetcher is resolved from brief's namespace at call time so that tests
    # patching brief.Fetcher intercept this construction site exactly as they
    # did when fetch_all lived in brief.py.
    from brief import Fetcher  # noqa: PLC0415 (runtime import to avoid a cycle)

    f = Fetcher(cfg["fetch"])
    items: list[dict] = []
    stats: dict[str, int] = {}

    def run(label, fn, spec):
        try:
            got = fn(f, spec)
            return label, got, None
        except Exception as e:  # one broken source must never sink the edition
            return label, [], f"{type(e).__name__}: {e}"

    if refresh_api:
        api_count = sum(1 for spec in _iter_feed_specs(src.get("feeds", {}))
                        if spec.get("kind") == "api")
        if api_count:
            _start_api_refresh(api_count)

    jobs = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for spec in _iter_feed_specs(src.get("feeds", {})):
            kind = spec.get("kind", "rss")
            if kind == "api":
                # Throttled API fetches run as a detached background refresh
                # (``--refresh-api-feeds``) so they never block the main
                # program; their results can be up to about a day old.
                continue
            fn = FETCHERS.get(kind)
            if fn is None:
                util.warn(
                    f"unknown feed kind {kind!r} for {spec.get('name', '?')!r}; skipping"
                )
                continue
            label = spec["name"]
            jobs.append(ex.submit(run, label, fn, spec))
        results = [j.result() for j in jobs]
    for label, got, err in results:
        if err:
            util.warn(f"source {label} failed ({err})")
        stats[label] = len(got)
        items.extend(got)
    util.log("fetched: " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    return items
