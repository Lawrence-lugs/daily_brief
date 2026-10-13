"""Unit tests for the non-network parts of brief.py.   python test_brief.py"""
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

if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok ", k)
