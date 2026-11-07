# Plan: ONE LLM API call for BOTH desks

## Problem
`src/brief.py` currently calls the editor LLM once per desk (`primary` / `science`) in a serialized loop:
- `build_user_message(desk_title, n, cands_for_llm, ...)` → per-desk user message
- `llm.chat(system, user)` → **one OpenRouter call per desk** = 2 calls per run
- `apply_editor(selected[desk], result, n)` → per-desk stories

This costs ~2x the LLM e2e latency and 2 `llm_requests` per edition.

## Insight
Desk membership is known **before** the LLM edit: selection (keyword or LR engine) already assigns each candidate to a desk via `item["desk"]` (subtopic → desk mapping in `sources.json`). So we can send all candidates from both desks in a **single** message, tagged by desk, and split the single response back per desk.

## Goal
Reduce LLM calls from **2 → 1 per run** while keeping:
- output shape `desks_out[desk] = {"title", "stories", "deck"}` unchanged,
- `db.append_brief`, SQLite schema, Node server (`queries.getBrief`, `render.js`), and the client unchanged,
- per-desk story count `n`, backfill-on-rejection, lead story, per-desk deck,
- graceful fallback: if the single call fails, both desks show raw items (same safety as today's per-desk failure).

## Files to change

### 1. `prompt_system.md` (the editor prompt)
- Address both desks by name/key: "Silicon & Architecture Desk (primary)" and "Science Desk (science)".
- New single JSON schema:
```json
{
  "decks": {
    "primary": {"deck": "<1 sentence, max 25 words>", "lead_id": "<id>"},
    "science": {"deck": "<...>", "lead_id": "<id>"}
  },
  "items": [
    {"id": "<copied exactly>", "desk": "primary|science", "keep": true,
     "headline": "<max 90 chars>", "blurb": "<2-3 sentences>",
     "why_care": "<max 20 words>", "tags": ["<=3"], "significance": 1..5}
  ]
}
```
- Hard rule: every kept item carries `"desk"` matching its pre-assigned desk; never move an item between desks.
- Require at least `{{max_agent_output_items_per_desk}}` kept items per desk (in order of importance); reject = omit or `keep: false`.
- Keep `{{max_agent_output_items_per_desk}}` placeholder (brief.py already replaces it).

### 2. `src/agent.py`
Add (keep legacy `build_user_message` / `apply_editor` for safety):
- `build_user_message_multi(desks, n, cands_by_desk, today, keep_cap) -> str`: ONE message listing every candidate from every desk; each slimmed candidate gains `"desk": <desk_key>`; section headers name each desk.
- `apply_editor_multi(selected_by_desk, result, n) -> dict[desk, (stories, rejected, deck)]`:
  - Read `result["decks"][desk]` for per-desk deck/lead_id; fall back to `result.get("deck")`/`lead_id` if absent.
  - Group kept items by `e["desk"]`; if missing, resolve desk by looking up the item id across all selected candidates (ids are globally unique and pre-assigned to exactly one desk).
  - Per desk: apply keep/reject, build stories (`{**c, headline, blurb, why_care, tags, significance, summarized}`), backfill from that desk's own non-rejected candidates to reach `n`, trim to `n`, sort by that desk's `lead_id` then significance.
  - Return per-desk `(stories, rejected, deck)`.

### 3. `src/brief.py` (lines ~344–376)
Replace the per-desk `llm.chat()` loop with:
1. Build `cands_by_desk = {desk: picks (or picks+reserves for keyword)}` — same per-desk candidate selection as today.
2. `prog.desk_working(desk, True)` for all desks; `prog.phase("editing")`.
3. **One** `llm.chat(system, build_user_message_multi(...))`.
4. `split = apply_editor_multi(selected, result, n)`; if `result is None` (call failed), fall back to `apply_editor(selected[desk], None, n)` per desk (raw items).
5. `prog.desk_edited(desk, stories, deck)` per desk; emit `run.event("editor", ...)` per desk as before; assemble `desks_out[desk]` exactly as today.

`llm_requests` will now count 1 instead of 2 when LLM is used.

### 4. `tests/test_agent.py` (new)
Pure-function unit tests, no network:
- `build_user_message_multi` mentions both desk titles/tags and each candidate carries its desk.
- `apply_editor_multi` splits one combined result into correct per-desk stories, honors `keep:false`, backfills per desk to `n`, applies per-desk lead sorting, returns per-desk decks.

### 5. `docs/architecture.md`
Update step 5 "Edit": single combined LLM call covering both desks; desk membership travels with each candidate; response split back per desk.

## Backwards compatibility / risk
- `--no-llm`: untouched (raw items per desk).
- LR engine: reserves still hidden from the LLM, still used for per-desk backfill.
- Keyword engine: picks + reserves still shown to the LLM (unchanged behavior).
- Malformed JSON: `extract_json`/`salvage_items` still operate on the whole response; recovered items carry `desk` if present, else resolve by id lookup.
- If the single call raises `LLMUnavailable`, both desks go raw (acceptable; previously only the failing desk went raw). Per-run cap `max_requests_per_run` unaffected.

## Verification
- `pytest tests/` must pass.
- Manual `python src/brief.py --no-llm` and (if a key is available) a full LLM run; confirm both desks get stories and `llm_requests == 1`.
