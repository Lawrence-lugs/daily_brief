"""Shared fixtures and mocked network responses for the daily_brief tests.

Network endpoints (arXiv via export.arxiv.org/rss.arxiv.org Atom XML,
Semantic Scholar JSON, OpenRouter chat completions) are mocked with
``unittest.mock`` (``monkeypatch`` on ``urllib.request.urlopen``) — no
``pytest-vcr`` cassette plugin is required, because pytest-vcr is not installed
in this environment. ``brief.CACHE`` is redirected to ``tmp_path`` so no real
HTTP cache is written under ``~/.cache/daily_brief``.
"""
from __future__ import annotations

import datetime as dt
import json
import random
import sys
from pathlib import Path

import pytest

# Make sure the repository root (where selection.py and brief.py live) is
# importable no matter which pytest import mode is active.
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
for _p in (str(SRC), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import brief  # noqa: E402
import selection as sel  # noqa: E402


def _load_config() -> dict:
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def _load_selection_cfg() -> dict:
    return {**sel.DEFAULTS, **_load_config()["selection"]}


@pytest.fixture
def cfg() -> dict:
    """Merged selection config (selection.DEFAULTS + config.json["selection"])."""
    return _load_selection_cfg()


@pytest.fixture
def fetch_cfg() -> dict:
    """Fetch config with zero delays, so tests never sleep on the network."""
    return {
        "timeout_s": 5,
        "cache_ttl_hours": 6,
        "arxiv_delay_s": 0.0,
        "api_delay_s": 0.0,
        "hn_lookback_days": 45,
        "user_agent": "daily-brief-test/1.0",
    }


@pytest.fixture
def rng() -> random.Random:
    return random.Random(0)


NOW = dt.datetime(2026, 10, 17, 12, 0, 0, tzinfo=dt.timezone.utc)


@pytest.fixture
def now() -> dt.datetime:
    return NOW


# --------------------------------------------------------------------------- mocked network payloads

class MockUrlResponse:
    """Minimal stand-in for urllib's addinfourl: context manager, .read(), .headers."""

    def __init__(self, text: str, status: int = 200, headers: dict | None = None):
        self._text = text
        self.status = status
        self.reason = "OK"
        self.headers = headers or {}

    def read(self, *args):
        return self._text.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


# arXiv Atom feed, as returned by export.arxiv.org/api/query (also understood
# by parse_feed when served from rss.arxiv.org).
ARXIV_ATOM = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>http://export.arxiv.org/api/query?search_query=all:dse&amp;start=0&amp;max_results=5</id>
  <updated>2026-10-07T12:00:00Z</updated>
  <entry>
    <id>http://arxiv.org/abs/2610.09641v2</id>
    <updated>2026-10-07T08:15:16Z</updated>
    <published>2026-10-07T08:15:16Z</published>
    <title>Q-PhotoMarket: A Design Space Exploration Framework for Photonic HQNNs</title>
    <summary>A systematic DSE framework for photonic hybrid quantum neural networks applied to financial market prediction.</summary>
    <link href="http://arxiv.org/abs/2610.09641v2"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2608.23404v1</id>
    <updated>2026-08-24T15:49:56Z</updated>
    <published>2026-08-24T15:49:56Z</published>
    <title>VIPER: Architecture-Aware Performance Modeling for PIM Design-Space Exploration</title>
    <summary>VIPER profiles host execution and combines it with a PIM-aware analytical engine for PIM DSE.</summary>
    <link href="http://arxiv.org/abs/2608.23404v1"/>
  </entry>
</feed>"""

SEMANTIC_SCHOLAR_JSON = {
    "data": [
        {
            "paperId": "s2-xyz",
            "title": "Agentic hardware optimization architecture search",
            "abstract": "We present an LLM agent for hardware architecture search and DSE.",
            "url": "https://www.semanticscholar.org/paper/s2-xyz",
            "publicationDate": "2026-10-05",
            "externalIds": {"ArXiv": "2610.09641"},
            "year": 2026,
        },
        {
            "paperId": "s2-noabs",
            "title": "A paper with no abstract",
            "abstract": "",
            "url": "https://www.semanticscholar.org/paper/s2-noabs",
            "publicationDate": "2026-10-04",
            "externalIds": {},
            "year": 2026,
        },
        {},  # no title: fetch_semanticscholar must skip it
    ],
    "total": 2,
}

OPENROUTER_CHAT_JSON = {
    "id": "resp-or-1",
    "model": "nvidia/nemotron-3-ultra-550b-a55b:free",
    "choices": [
        {
            "message": {
                "content": (
                    '```json\n'
                    '{"items": ['
                    '{"id":"cand-a","keep":true,"headline":"Headline A","blurb":"Blurb A sentence one. Sentence two.",'
                    '"significance":4,"tags":["dse"],"why_care":"It matters."},'
                    '{"id":"cand-b","keep":false,"headline":"Headline B","blurb":"Blurb B."}'
                    '],'
                    '"deck":"Desk deck","lead_id":"cand-a"}'
                    '\n```'
                ),
                "finish_reason": "stop",
            }
        }
    ],
    "usage": {"total_tokens": 120},
}


def _make_urlopen_dispatcher(responses: dict[str, MockUrlResponse]):
    """Return a urlopen stand-in that dispatches on the request URL host."""

    def urlopen(req, *args, **kwargs):
        url = getattr(req, "full_url", str(req))
        for host, response in responses.items():
            if host in url:
                return response
        raise AssertionError(f"no mocked response for URL: {url}")

    return urlopen


@pytest.fixture
def mocked_urlopen(monkeypatch, tmp_path):
    """Mock ``urllib.request.urlopen`` for arXiv (Atom XML), Semantic Scholar
    (JSON) and OpenRouter (chat completions JSON). Also mocks the OpenRouter
    key-quota endpoint. The real HTTP cache is redirected to ``tmp_path``."""
    responses = {
        "export.arxiv.org": MockUrlResponse(ARXIV_ATOM),
        "rss.arxiv.org": MockUrlResponse(ARXIV_ATOM),
        "api.semanticscholar.org": MockUrlResponse(json.dumps(SEMANTIC_SCHOLAR_JSON)),
        "openrouter.ai/api/v1/key": MockUrlResponse(
            json.dumps({"data": {"free_model_daily_requests": {"remaining": 42}}})
        ),
        "openrouter.ai": MockUrlResponse(json.dumps(OPENROUTER_CHAT_JSON)),
    }
    monkeypatch.setattr(brief, "CACHE", tmp_path / "cache")
    monkeypatch.setattr("urllib.request.urlopen", _make_urlopen_dispatcher(responses))
    return responses
