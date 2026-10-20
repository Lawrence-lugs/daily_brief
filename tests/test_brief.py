"""Migrated and extended unit tests for brief.py.

Migrated from the repo-root ``test_brief.py`` (imports adjusted, the two LLM
configs gained the ``"effort"`` key that ``brief.LLM.chat`` now requires — the
root-level tests fail against current brief.py without it) plus new tests that
mock every network endpoint: arXiv (Atom XML via export.arxiv.org / rss.arxiv.org),
Semantic Scholar (JSON) and OpenRouter (chat completions).

All network mocking uses ``unittest.mock`` through the ``mocked_urlopen``
fixture in conftest.py — no network is touched and no HTTP cache is written.
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.error
from unittest.mock import patch

import brief
import selection as sel

CANDS = [
    {"id": "a", "title": "Raw A", "snippet": "snip a", "subtopic": "dse", "kind": "fresh", "age_days": 1, "source": "s", "url": "https://x/a", "mode": "greedy"},
    {"id": "b", "title": "Raw B", "snippet": "snip b", "subtopic": "dse", "kind": "fresh", "age_days": 2, "source": "s", "url": "https://x/b", "mode": "greedy"},
    {"id": "c", "title": "Raw C", "snippet": "snip c", "subtopic": "accel", "kind": "archive", "age_days": 20, "source": "s", "url": "https://x/c", "mode": "explore"},
]


# --------------------------------------------------------------------------- migrated from repo root

def test_extract_plain_and_fenced():
    assert brief.extract_json('```json\n{"items": []}\n```') == {"items": []}
    assert brief.extract_json('Sure! {"items": []} hope that helps') == {"items": []}


def test_salvage_malformed():
    bad = ('{"deck":"d","lead_id":"b","items":[{"id":"a","keep":true,"headline":"H","blurb":"B {x}"},'
           '{"id":"b","headline":"broken" "blurb":1},{"id":"c","keep":false})')
    r = brief.extract_json(bad)
    assert r["_salvaged"] and [i["id"] for i in r["items"]] == ["a", "c"]
    assert r["deck"] == "d" and r["lead_id"] == "b"


def test_apply_editor_rejects_unknown_ids_and_backfills():
    result = {"deck": "D", "lead_id": "zzz", "items": [
        {"id": "nope", "keep": True, "headline": "x", "blurb": "y"},       # invented id: ignored
        {"id": "b", "keep": True, "headline": "Hb", "blurb": "Bb", "significance": 9, "tags": ["t"]},
        {"id": "a", "keep": False},
    ]}
    stories, rejected, deck = brief.apply_editor(CANDS, result, 2)
    assert rejected == ["a"] and deck == "D"
    assert [s["id"] for s in stories] == ["b", "c"]       # a rejected, c backfilled raw
    assert stories[0]["significance"] == 5 and stories[0]["summarized"]
    assert not stories[1]["summarized"] and stories[1]["headline"] == "Raw C"


def test_apply_editor_without_llm():
    stories, rejected, deck = brief.apply_editor(CANDS, None, 2)
    assert [s["id"] for s in stories] == ["a", "b"] and rejected == [] and deck == ""


def test_render_escapes_html_and_blocks_bad_urls():
    s = {**CANDS[0], "headline": "<script>alert(1)</script>", "blurb": "b", "why_care": "", "tags": ["<b>"],
         "summarized": True, "url": "javascript:alert(1)"}
    out = brief.render_story(s, lead=False)
    assert "<script>" not in out and "&lt;script&gt;" in out
    assert 'href="#"' in out and "javascript:" not in out


def test_render_page_reads_project_root_css():
    """render_page reads tailwind.css from the project root (not src/).
    This is the function that failed after the src/ move when the CSS path
    was still rooted at src/."""
    cfg = {"paper_name": "Test Paper"}
    now = dt.datetime(2026, 10, 20, 12, 0, 0, tzinfo=dt.timezone.utc)
    desks = {
        "primary": {"title": "Primary Desk", "deck": "deck", "stories": []},
        "science": {"title": "Science Desk", "deck": "deck", "stories": []},
    }
    meta = {
        "model": "test-model", "n_fresh": 0, "n_archive": 0, "n_explore": 0,
        "epsilon": 0.25, "pool": 0, "sources": "",
    }
    out = brief.render_page(cfg, now, 1, desks, meta)
    assert "<html" in out and "Test Paper" in out
    assert "body" in out.lower()  # Tailwind CSS was inlined


def test_canonical_url():
    assert brief.canonical_url("http://arxiv.org/abs/2610.09641v2") == "https://arxiv.org/abs/2610.09641"
    assert brief.canonical_url("https://Example.com/a/?utm_source=x&id=3#frag") == "https://example.com/a?id=3"


def test_short_keywords_are_whole_words():
    kw = {"dse": ["eda", "dse", "cosmolog"], "gr": ["black hole"]}
    s2d = {"dse": "primary", "gr": "science"}
    mk = lambda title, snip="": {"title": title, "snippet": snip, "hint": None, "weight": 1.0}
    assert brief.classify(mk("Needed media coverage", "the dseries tableau"), kw, s2d) is None
    assert brief.classify(mk("EDA tools for placement", "uses DSE"), kw, s2d)["subtopic"] == "dse"
    assert brief.classify(mk("Cosmological constraints", "a black hole"), kw, s2d)["subtopic"] in ("dse", "gr")


def test_feed_source_type_is_preserved():
    xml = """<rss><channel><item><title>EDA report</title>
    <link>https://example.com/report</link><description>EDA tools</description></item></channel></rss>"""
    items = brief.parse_feed(xml, "Example", 1.0, "dse", "newslike")
    assert items[0]["source_type"] == "newslike"


def test_project_root_assets_resolve_outside_src():
    """After the src/ move, project-root assets (tailwind.css, config.json,
    sources.json, prompt_system.md, state.json) must resolve from the project
    root, not from src/. A regression here breaks every real render/run."""
    from pathlib import Path
    repo_root = Path(__file__).resolve().parent.parent
    assert brief.PROJECT_ROOT == repo_root
    assert (brief.PROJECT_ROOT / "tailwind.css").exists(), "tailwind.css must live at project root"
    assert (brief.PROJECT_ROOT / "config.json").exists()
    assert (brief.PROJECT_ROOT / "sources.json").exists()
    assert (brief.PROJECT_ROOT / "prompt_system.md").exists()
    # templates live under src/
    assert (brief.TEMPLATES / "page.html").exists()
    assert (brief.TEMPLATES / "tag.html").exists()


def test_llm_falls_back_in_configured_order():
    llm = object.__new__(brief.LLM)
    llm.cfg = {"models": ["first/model", "second/model"], "temperature": 0.3, "max_tokens": 100,
               "retries": 2, "max_requests_per_run": 6, "timeout_s": 10, "effort": "high"}
    llm.requests = 0
    llm.models = []
    attempted = []

    def request(_url, body, _timeout):
        attempted.append(body["model"])
        if body["model"] == "first/model":
            raise urllib.error.HTTPError(
                "https://example.com", 404, "missing model", {}, None
            )
        return {"model": "second/model", "choices": [{"message": {"content": '{"items": []}'}}]}, {}, ""

    llm._http = request
    assert llm.chat("system", "user") == {"items": []}
    assert attempted == ["first/model", "second/model"]
    assert llm.models == ["second/model"] and llm.requests == 2


def test_llm_logs_empty_response_details_before_fallback():
    llm = object.__new__(brief.LLM)
    llm.cfg = {"models": ["empty/model", "working/model"], "temperature": 0.3, "max_tokens": 100,
               "retries": 0, "max_requests_per_run": 2, "timeout_s": 10, "effort": "high"}
    llm.requests = 0
    llm.models = []
    brief.WARNINGS.clear()
    responses = iter([
        ({"id": "response-123", "model": "empty/model",
          "choices": [{"message": {"content": ""}, "finish_reason": "length"}],
          "usage": {"completion_tokens": 100}}, {}, ""),
        ({"model": "working/model", "choices": [{"message": {"content": '{"items": []}'}}]}, {}, ""),
    ])
    llm._http = lambda *_args: next(responses)
    with patch.object(brief.time, "sleep"):
        assert llm.chat("system", "user") == {"items": []}
    assert any("response-123" in warning and "'length'" in warning
               for warning in brief.WARNINGS)
    brief.WARNINGS.clear()


def test_semanticscholar_refresh_is_started_separately(tmp_path, monkeypatch):
    source = {"name": "S2 test", "query": "test", "subtopic": "dse",
              "weight": 1.0, "type": "researchlike", "kind": "api", "fetcher": "semanticscholar"}
    # Keep the real cache out of ~/.cache for this migrated test too.
    monkeypatch.setattr(brief, "CACHE", tmp_path / "cache")
    with patch.object(brief, "Fetcher"), patch("subprocess.Popen") as popen:
        assert brief.fetch_all({"fetch": {}},
                               {"feeds": {"api": {"semanticscholar": [source]}}}) == []
    command = popen.call_args.args[0]
    assert "--refresh-api-feeds" in command


def test_fetch_all_skips_api_feeds(tmp_path, monkeypatch):
    """RSS specs are fetched; "api" specs are skipped and background-refresh
    is spawned (Popen called with --refresh-api-feeds)."""
    monkeypatch.setattr(brief, "CACHE", tmp_path / "cache")
    import fetch  # noqa: E402  (src on sys.path via conftest)

    fetched = []

    def fake_fetch_rss(f, spec):
        fetched.append(spec["name"])
        return [{"id": "x", "title": spec["name"]}]

    with patch.object(fetch.fetcher, "FETCHERS", {"rss": fake_fetch_rss}):
        with patch("subprocess.Popen") as popen:
            items = brief.fetch_all({"fetch": {}}, {
                "feeds": {
                    "rss": [{"name": "RSS One", "kind": "rss"}],
                    "api": [{"name": "API One", "kind": "api",
                             "fetcher": "semanticscholar"}],
                }
            })
    assert [i["title"] for i in items] == ["RSS One"]
    assert fetched == ["RSS One"]
    assert "--refresh-api-feeds" in popen.call_args.args[0]


def test_fetch_all_skips_unknown_kind(tmp_path, monkeypatch):
    """An unknown/missing feed kind is warned and skipped, not a hard crash."""
    monkeypatch.setattr(brief, "CACHE", tmp_path / "cache")
    brief.WARNINGS.clear()
    with patch("subprocess.Popen") as popen:  # no api feeds -> nothing spawned
        items = brief.fetch_all({"fetch": {}},
                                {"feeds": {"rss": [{"name": "Weird", "kind": "mystery"}]}})
    assert items == []
    assert popen.call_args is None
    assert any("unknown feed kind" in w for w in brief.WARNINGS)


def test_no_refresh_api_feeds_spawns_nothing(tmp_path, monkeypatch):
    """refresh_api=False must not spawn the background refresh process."""
    monkeypatch.setattr(brief, "CACHE", tmp_path / "cache")
    with patch("subprocess.Popen") as popen:
        items = brief.fetch_all({"fetch": {}}, {
            "feeds": {"api": [{"name": "API One", "kind": "api",
                              "fetcher": "semanticscholar"}]}
        }, refresh_api=False)
    assert items == []
    assert popen.call_args is None


def test_refresh_api_feeds_dispatches_per_spec(tmp_path, monkeypatch):
    """refresh_api_feeds calls each registered api fetcher per spec and
    warns-and-skips specs whose fetcher is unregistered."""
    monkeypatch.setattr(brief, "CACHE", tmp_path / "cache")
    brief.WARNINGS.clear()
    import fetch  # noqa: E402
    from fetch import fetcher as fetch_mod

    calls = []

    def fetcher_a(f, spec):
        calls.append(spec["name"])
        return [{"id": "a", "title": spec["name"]}]

    def fetcher_b(f, spec):
        calls.append(spec["name"])
        return [{"id": "b", "title": spec["name"]}]

    fetch_mod.API_FETCHERS["reg-a"] = fetcher_a
    fetch_mod.API_FETCHERS["reg-b"] = fetcher_b
    try:
        items = brief.refresh_api_feeds({"fetch": {}}, {
            "feeds": {
                "api": [
                    {"name": "Source A", "kind": "api", "fetcher": "reg-a"},
                    {"name": "Source B", "kind": "api", "fetcher": "reg-b"},
                    {"name": "Source C", "kind": "api", "fetcher": "nope"},
                ]
            }
        })
    finally:
        del fetch_mod.API_FETCHERS["reg-a"]
        del fetch_mod.API_FETCHERS["reg-b"]
    assert [i["title"] for i in items] == ["Source A", "Source B"]
    assert calls == ["Source A", "Source B"]
    assert any("no api fetcher registered" in w for w in brief.WARNINGS)


def test_iter_feed_specs_handles_both_groupings():
    """_iter_feed_specs accepts flat lists and dict-of-lists grouping."""
    from fetch.fetcher import _iter_feed_specs
    flat = {"api": [{"name": "a"}, {"name": "b"}], "rss": [{"name": "c"}]}
    nested = {"api": {"s1": [{"name": "a"}], "s2": [{"name": "b"}]},
              "rss": [{"name": "c"}]}
    assert [s["name"] for s in _iter_feed_specs(flat)] == ["a", "b", "c"]
    assert [s["name"] for s in _iter_feed_specs(nested)] == ["a", "b", "c"]


# --------------------------------------------------------------------------- new: mocked network endpoints

def test_arxiv_atom_fetch_mocked(mocked_urlopen, fetch_cfg):
    """arXiv via export.arxiv.org Atom XML, fetched end-to-end through fetch_rss."""
    f = brief.Fetcher(fetch_cfg)
    spec = {
        "name": "arXiv test", "weight": 1.0, "type": "researchlike",
        "default_subtopic": "dse", "kind": "rss",
        "url": "https://export.arxiv.org/api/query?search_query=all:dse&start=0&max_results=5",
    }
    items = brief.fetch_rss(f, spec)
    assert len(items) == 2
    assert items[0]["source_type"] == "researchlike"
    assert items[0]["hint"] == "dse"  # "subtopic" is set later by classify()
    assert items[0]["url"] == "https://arxiv.org/abs/2610.09641"  # v2 stripped by canonical_url
    assert items[0]["title"] == "Q-PhotoMarket: A Design Space Exploration Framework for Photonic HQNNs"
    assert items[1]["url"] == "https://arxiv.org/abs/2608.23404"


def test_arxiv_rss_fetch_mocked(mocked_urlopen, fetch_cfg):
    """The same Atom payload also parses when served from rss.arxiv.org (RSS kind)."""
    f = brief.Fetcher(fetch_cfg)
    spec = {
        "name": "arXiv RSS", "weight": 1.0, "type": "researchlike",
        "default_subtopic": "accel", "kind": "rss",
        "url": "https://rss.arxiv.org/rss/cs.AR",
    }
    items = brief.fetch_rss(f, spec)
    assert len(items) == 2
    assert items[0]["source_type"] == "researchlike"
    assert items[0]["hint"] == "accel"  # "subtopic" is set later by classify()
    assert items[0]["url"] == "https://arxiv.org/abs/2610.09641"


def test_semantic_scholar_fetch_mocked(mocked_urlopen, fetch_cfg):
    """Semantic Scholar JSON: arxiv_id URLs win, title-less entries are skipped."""
    f = brief.Fetcher(fetch_cfg)
    spec = {
        "name": "S2 DSE", "query": "hardware accelerator design space exploration",
        "subtopic": "dse", "weight": 1.0, "type": "researchlike", "limit": 12,
        "kind": "semanticscholar",
    }
    items = brief.fetch_semanticscholar(f, spec)
    assert len(items) == 2  # the title-less entry is skipped
    assert items[0]["hint"] == "dse"  # "subtopic" is set later by classify()
    assert items[0]["source_type"] == "researchlike"
    assert items[0]["title"] == "Agentic hardware optimization architecture search"
    assert items[0]["url"] == "https://arxiv.org/abs/2610.09641"  # externalIds.ArXiv wins
    assert items[1]["title"] == "A paper with no abstract"
    assert items[1]["url"] == "https://www.semanticscholar.org/paper/s2-noabs"


def _llm_stub():
    """Build an LLM stub without touching the real key file / env."""
    llm = object.__new__(brief.LLM)
    llm.cfg = {
        "models": ["nvidia/nemotron-3-ultra-550b-a55b:free",
                   "nvidia/nemotron-3-super-120b-a12b:free"],
        "temperature": 0.3, "max_tokens": 5000, "retries": 0,
        "max_requests_per_run": 24, "timeout_s": 150, "effort": "high",
    }
    llm.requests = 0
    llm.models = []
    llm.key = "test-key"
    return llm


def test_openrouter_response_parsing(mocked_urlopen):
    """OpenRouter chat completions: fenced JSON is parsed through the mocked transport."""
    llm = _llm_stub()
    result = llm.chat("system", "user")
    assert llm.requests == 1
    assert llm.models == ["nvidia/nemotron-3-ultra-550b-a55b:free"]
    assert result["deck"] == "Desk deck"
    assert result["lead_id"] == "cand-a"
    assert [i["id"] for i in result["items"]] == ["cand-a", "cand-b"]
    assert result["items"][0]["keep"] is True
    assert result["items"][0]["headline"] == "Headline A"
    assert result["items"][1]["keep"] is False


def test_openrouter_empty_content_falls_back_and_warns():
    """Empty model content fails that model, warns with details, and falls back."""
    llm = _llm_stub()
    llm.cfg["models"] = ["empty/model", "working/model"]
    llm.cfg["max_requests_per_run"] = 2
    brief.WARNINGS.clear()
    responses = iter([
        ({"id": "response-123", "model": "empty/model",
          "choices": [{"message": {"content": ""}, "finish_reason": "length"}],
          "usage": {"completion_tokens": 100}}, {}, ""),
        ({"model": "working/model", "choices": [{"message": {"content": '{"items": []}'}}]}, {}, ""),
    ])
    llm._http = lambda *_args: next(responses)
    with patch.object(brief.time, "sleep"):
        assert llm.chat("system", "user") == {"items": []}
    assert any("response-123" in warning and "'length'" in warning
               for warning in brief.WARNINGS)
    assert llm.models == ["working/model"]
    brief.WARNINGS.clear()


def test_openrouter_unauthorized_is_fatal(mocked_urlopen):
    """HTTP 401 from OpenRouter raises LLMUnavailable (no model can fix a bad key)."""
    llm = _llm_stub()
    llm.cfg["retries"] = 0

    def http(url, body=None, timeout=30):
        raise urllib.error.HTTPError(url, 401, "invalid key", {}, None)

    llm._http = http
    try:
        llm.chat("system", "user")
    except brief.LLMUnavailable as e:
        assert "HTTP 401" in str(e)
    else:
        raise AssertionError("expected LLMUnavailable for HTTP 401")
