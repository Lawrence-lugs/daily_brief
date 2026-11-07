"""Unit tests for the single-call, multi-desk editor in agent.py.

agent.py functions are pure (no I/O unless logging), so these need no network mocks.
"""
from __future__ import annotations

import agent as A


def _item(iid: str, desk: str, subtopic: str, mode: str = "greedy", kind: str = "fresh",
          source_type: str = "researchlike", title: str | None = None,
          snippet: str | None = None) -> dict:
    return {
        "id": iid, "title": title or f"Title {iid}", "snippet": snippet or f"Snippet for {iid}",
        "subtopic": subtopic, "desk": desk, "kind": kind, "source": "arXiv",
        "source_type": source_type, "age_days": 1.0, "mode": mode,
        "times_shown": 0, "rejected": 0, "url": f"http://x/{iid}",
    }


PRIMARY = [_item("p1", "primary", "accel"), _item("p2", "primary", "dse", mode="explore"),
           _item("p3", "primary", "fab", kind="archive", source_type="newslike")]
SCIENCE = [_item("s1", "science", "gr"), _item("s2", "science", "qft"),
           _item("s3", "science", "neuro")]
SELECTED = {"primary": PRIMARY, "science": SCIENCE}
N = 2


def test_build_user_message_multi_mentions_both_desks_and_tags_candidates():
    msg = A.build_user_message_multi(
        [{"key": "primary", "title": "Silicon & Architecture Desk"},
         {"key": "science", "title": "Science Desk"}],
        N, {"primary": PRIMARY, "science": SCIENCE}, "Monday 2026-11-07", keep_cap=N,
    )
    assert "Silicon & Architecture Desk" in msg
    assert "Science Desk" in msg
    assert "DESK: primary — Silicon & Architecture Desk" in msg
    assert "DESK: science — Science Desk" in msg
    # every candidate is listed and tagged with its desk; never moved between desks
    assert msg.count('"desk": "primary"') == len(PRIMARY)
    assert msg.count('"desk": "science"') == len(SCIENCE)
    for c in PRIMARY + SCIENCE:
        assert f'"id": "{c["id"]}"' in msg


def test_apply_editor_multi_splits_per_desk_and_backfills():
    result = {
        "decks": {
            "primary": {"deck": "Primary deck sentence here.", "lead_id": "p1"},
            "science": {"deck": "Science deck sentence here.", "lead_id": "s1"},
        },
        "items": [
            {"id": "p1", "desk": "primary", "keep": True,
             "headline": "P1 headline", "blurb": "P1 blurb sentence one. P1 sentence two.",
             "why_care": "Matters to hardware.", "tags": ["accel"], "significance": 4},
            # p2 explicitly rejected, carries no desk but resolves by id lookup
            {"id": "p2", "keep": False},
            {"id": "s1", "desk": "science", "keep": True,
             "headline": "S1 headline", "blurb": "S1 blurb sentence one. S1 sentence two.",
             "why_care": "Physics matters.", "tags": ["gr"], "significance": 5},
            # s3 omitted entirely -> raw backfill; s2 missing "desk" -> resolve by id lookup
            {"id": "s2", "keep": True,
             "headline": "S2 headline", "blurb": "S2 blurb sentence one. S2 sentence two.",
             "why_care": "Also physics.", "tags": ["qft"], "significance": 3},
        ],
    }
    split = A.apply_editor_multi(SELECTED, result, N)
    assert set(split) == {"primary", "science"}

    p_stories, p_rej, p_deck = split["primary"]
    assert p_deck == "Primary deck sentence here."
    assert p_rej == ["p2"]
    assert [s["id"] for s in p_stories] == ["p1", "p3"]  # p1 kept, p3 raw backfill
    assert p_stories[0]["summarized"] is True
    assert p_stories[1]["summarized"] is False  # raw backfill
    assert p_stories[0]["headline"] == "P1 headline"
    assert p_stories[1]["headline"] == "Title p3"

    s_stories, s_rej, s_deck = split["science"]
    assert s_deck == "Science deck sentence here."
    assert s_rej == []
    assert [s["id"] for s in s_stories] == ["s1", "s2"]  # lead first, then s2 (resolved by id lookup)
    assert s_stories[0]["summarized"] is True
    assert s_stories[1]["headline"] == "S2 headline"


def test_apply_editor_multi_none_result_is_raw_per_desk():
    split = A.apply_editor_multi(SELECTED, None, N)
    p_stories, p_rej, p_deck = split["primary"]
    s_stories, s_rej, s_deck = split["science"]
    assert p_rej == [] and s_rej == []
    assert p_deck == "" and s_deck == ""
    assert [s["id"] for s in p_stories] == ["p1", "p2"]
    assert [s["id"] for s in s_stories] == ["s1", "s2"]
    assert all(s["summarized"] is False for s in p_stories + s_stories)


def test_apply_editor_multi_trims_to_n_and_respects_lead():
    # editor returns more than n on one desk -> trimmed to n first (mirrors apply_editor), then:
    # lead forced first if present; otherwise significance order.
    result = {
        "decks": {"primary": {"deck": "D.", "lead_id": "p1"}, "science": {"deck": "D.", "lead_id": "s3"}},
        "items": [
            {"id": "p1", "desk": "primary", "keep": True, "headline": "H1", "blurb": "B one. B two.", "significance": 1},
            {"id": "p2", "desk": "primary", "keep": True, "headline": "H2", "blurb": "B one. B two.", "significance": 5},
            {"id": "p3", "desk": "primary", "keep": True, "headline": "H3", "blurb": "B one. B two.", "significance": 1},
            {"id": "s1", "desk": "science", "keep": True, "headline": "H1", "blurb": "B one. B two.", "significance": 1},
            {"id": "s2", "desk": "science", "keep": True, "headline": "H2", "blurb": "B one. B two.", "significance": 5},
            {"id": "s3", "desk": "science", "keep": True, "headline": "H3", "blurb": "B one. B two.", "significance": 1},
        ],
    }
    split = A.apply_editor_multi(SELECTED, result, N)
    assert [s["id"] for s in split["primary"][0]] == ["p1", "p2"]  # lead p1 forced first (sig 1 over p2 sig 5)
    assert [s["id"] for s in split["science"][0]] == ["s2", "s1"]  # lead s3 out of top-n -> significance order


def test_apply_editor_multi_empty_stories_no_crash():
    # every candidate on a desk rejected -> backfill finds nothing -> stories empty; lead sort must not crash
    # (mirrors the `if result and stories` guard in the original apply_editor). Deck still comes from result.
    result = {
        "decks": {"primary": {"deck": "D.", "lead_id": "p1"}, "science": {"deck": "D.", "lead_id": "s1"}},
        "items": [
            {"id": "p1", "desk": "primary", "keep": False},
            {"id": "p2", "desk": "primary", "keep": False},
            {"id": "p3", "desk": "primary", "keep": False},
            {"id": "s1", "desk": "science", "keep": False},
            {"id": "s2", "desk": "science", "keep": False},
            {"id": "s3", "desk": "science", "keep": False},
        ],
    }
    split = A.apply_editor_multi(SELECTED, result, N)
    assert split["primary"] == ([], ["p1", "p2", "p3"], "D.")
    assert split["science"] == ([], ["s1", "s2", "s3"], "D.")
