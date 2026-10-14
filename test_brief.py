"""Unit tests for the non-network parts of brief.py.   python test_brief.py"""
import urllib.error
from unittest.mock import patch

import brief

CANDS = [
    {"id": "a", "title": "Raw A", "snippet": "snip a", "subtopic": "dse", "kind": "fresh", "age_days": 1, "source": "s", "url": "https://x/a", "mode": "greedy"},
    {"id": "b", "title": "Raw B", "snippet": "snip b", "subtopic": "dse", "kind": "fresh", "age_days": 2, "source": "s", "url": "https://x/b", "mode": "greedy"},
    {"id": "c", "title": "Raw C", "snippet": "snip c", "subtopic": "accel", "kind": "archive", "age_days": 20, "source": "s", "url": "https://x/c", "mode": "explore"},
]


def test_extract_plain_and_fenced():
    assert brief.extract_json('```json\n{"items": []}\n```') == {"items": []}
    assert brief.extract_json('Sure! {"items": []} hope that helps') == {"items": []}


def test_salvage_malformed():
    bad = ('{"deck":"d","lead_id":"b","items":[{"id":"a","keep":true,"headline":"H","blurb":"B {x}"},'
           '{"id":"b","headline":"broken" "blurb":1},{"id":"c","keep":false}')
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


def test_llm_falls_back_in_configured_order():
    llm = object.__new__(brief.LLM)
    llm.cfg = {"models": ["first/model", "second/model"], "temperature": 0.3, "max_tokens": 100,
               "retries": 2, "max_requests_per_run": 6, "timeout_s": 10}
    llm.requests = 0
    llm.models = []
    attempted = []

    def request(_url, body, _timeout):
        attempted.append(body["model"])
        if body["model"] == "first/model":
            raise urllib.error.HTTPError(
                "https://example.com", 404, "missing model", {}, None
            )
        return {"model": "second/model", "choices": [{"message": {"content": '{"items": []}'}}]}, {}

    llm._http = request
    assert llm.chat("system", "user") == {"items": []}
    assert attempted == ["first/model", "second/model"]
    assert llm.models == ["second/model"] and llm.requests == 2


def test_llm_logs_empty_response_details_before_fallback():
    llm = object.__new__(brief.LLM)
    llm.cfg = {"models": ["empty/model", "working/model"], "temperature": 0.3, "max_tokens": 100,
               "retries": 0, "max_requests_per_run": 2, "timeout_s": 10}
    llm.requests = 0
    llm.models = []
    brief.WARNINGS.clear()
    responses = iter([
        ({"id": "response-123", "model": "empty/model",
          "choices": [{"message": {"content": ""}, "finish_reason": "length"}],
          "usage": {"completion_tokens": 100}}, {}),
        ({"model": "working/model", "choices": [{"message": {"content": '{"items": []}'}}]}, {}),
    ])
    llm._http = lambda *_args: next(responses)
    with patch.object(brief.time, "sleep"):
        assert llm.chat("system", "user") == {"items": []}
    assert any("response-123" in warning and "'length'" in warning
               for warning in brief.WARNINGS)
    brief.WARNINGS.clear()


def test_semanticscholar_refresh_is_started_separately():
    source = {"name": "S2 test", "query": "test", "subtopic": "dse",
              "weight": 1.0, "type": "researchlike"}
    with patch.object(brief, "Fetcher"), patch.object(brief.subprocess, "Popen") as popen:
        assert brief.fetch_all({"fetch": {}}, {"semanticscholar": [source]}) == []
    command = popen.call_args.args[0]
    assert "--refresh-s2" in command


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok ", k)
