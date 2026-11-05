# Perceived-performance for brief generation: what is done, what is left

Status: the logic is written and tested (10 tests). What is left is wiring into files that were not
available to edit (`brief.py`, `app.js`, `page.html`, CSS). Phases A to C each fit one subagent.

## What changed versus the first plan (cross-check findings)

1. **Log parsing for progress cannot work.** brief.py logs per-desk lines only *before* the editor runs, and
   nothing when a desk finishes. Replaced by a structured `progress.json` (src/progress.py), tailed by jobs.js.
2. **Preview cards cannot be liked/saved.** `story_id` comes from the DB insert at the very end, so there is no
   id to send to `/api/stories/:id/feedback`. Preview cards are inert (`.is-preview`); the swap enables them.
3. **"LR winners are pre-decided" is true, and here is why.** In brief.py the editor gets only the 5 picks for
   LR (`cands_for_llm` drops reserves) and is told to keep at least 5, so it practically cannot reject. For
   keyword it gets picks + 25 reserves and really chooses. Caveats for LR: the lead and the order are decided by
   the editor (`apply_editor` re-sorts), so the swap re-renders the whole desk instead of patching cards.
4. **Per-desk reveal is free** with the progress file: each desk flips raw -> edited the moment its editor call
   returns (both engines). Keyword gets this too, just without the raw stage.
5. **Do not full-reload at the end.** The client fetches `/` and swaps `[data-swap]` regions (fallback: reload).
6. **Not done, highest real payoff: run the two desks' editor calls concurrently** (about 2x faster, 60-90s ->
   30-45s). Not in scope here because `LLM` shares `requests`/`models` counters and brief.py sets `llm = None`
   on failure; needs a lock and care with free-tier 429s. See Phase E.

## Contract (do not change without updating both sides)

`progress.json` (src/progress.py docstring) -> `JobRunner.view(id, since, pseq)` returns `progress` only when
`seq` changed -> `/api/job` adds `preview` (server-rendered card HTML per desk) -> client.

## Phase A: brief.py (Python, ~15 min)

Copy `src/progress.py` and `src/test_progress.py` into `src/`. Edit `src/brief.py`:

```python
# 1. imports (after `from runlog import RunLog`)
from progress import Progress

# 2. argparse (after the --log-file line)
ap.add_argument("--progress-file", type=Path, help=argparse.SUPPRESS)

# 3. right after `run = RunLog(...)` and BEFORE "# 1. fetch + classify + upsert"
prog = Progress(args.progress_file)

# 4. right before "# 2. Selection per desk"
prog.phase("selecting")

# 5. after the keyword-engine block, before `for desk, items in selected.items(): run.event("selection", ...`
prog.set_engine(engine)          # final engine, after any LR -> keyword fallback

# 6. after `system = system.replace("{{max_agent_output_items_per_desk}}", ...)`, BEFORE the editor loop
for desk, spec in src["desks"].items():
    prog.desk_init(desk, spec["title"], n)
    if engine == "lr":           # winners are pre-decided: show them raw while the editor works
        prog.desk_raw(desk, [c for c in selected[desk] if c["mode"] != "reserve"])
prog.phase("editing")

# 7. inside the editor loop: first line after `result = None`
prog.desk_working(desk, True)
#    and directly after `stories, rejected, deck = apply_editor(selected[desk], result, n)`
prog.desk_edited(desk, stories, deck)

# 8. right before `brief_id = db.append_brief(` (after the dry-run return) and after the final log(...)
prog.phase("committing")
...
prog.phase("done")
```
Check: `python src/test_progress.py`; then `python src/brief.py --no-fetch --no-llm --dry-run --progress-file %TEMP%\p.json`
and open the JSON: phases should end `committing`-less (dry run returns early), desks `edited`, no NaN.

## Phase B: server (JS, ~20 min)

Copy `server/lib/jobs.js` (full replacement) and `server/lib/progress.js`. Edit `server/app.js`:

```js
import { buildPreview } from './lib/progress.js';          // with the other imports

// replace the /api/job route
if (p === '/api/job') {
  const v = jobs.view(Number(url.searchParams.get('id')), url.searchParams.get('since'), url.searchParams.get('pseq'));
  if (v.progress) v.preview = buildPreview(v.progress, { renderStory: renderer.renderStory, medoidTitle: q.medoidTitle });
  delete v.progress;
  return json(res, 200, v);
}
```
Do Phase A first: until brief.py accepts `--progress-file`, build the runner with `progress: false`.
Copy tests `server/test/{progress,genmodel,jobs}.test.js` and run them with the repo's own test command
(Node >= 22 needs explicit files or a glob, not a bare directory). Then `curl "localhost:PORT/api/job?id=0&since=0&pseq=-1"`
during a real run: expect `preview.desks.primary.stage` going `pending -> raw -> edited`.

## Phase C: page + CSS (~30 min; this is where my assumptions about unseen files bite)

I never saw `page.html`, the story templates, `formatBackside`, or the tailwind build. Required in `page.html`:

1. `<script src="/static/genmodel.js"></script>` immediately before the `client.js` tag.
2. `<section id="gen-panel" class="gen-panel" hidden aria-live="polite"></section>` under the toolbar.
3. Per desk (desk keys = `sources.json` desks, i.e. `primary`, `science`):
   `<section data-swap="desk-primary"> <p data-desk-deck="primary">{{primary_deck}}</p> <div data-desk-stories="primary">{{primary_stories}}</div> </section>`
   Same for science. The stories container must hold only story cards (each `.story-card`).
4. Wrap masthead (date/edition/generated) in `data-swap="masthead"` and the footer in `data-swap="footer"`.
5. `#status`, `#log-popup`, `#btn-*`, `#engine-select` and the `#brief-select` element itself stay OUTSIDE `[data-swap]`.
6. Append `gen.css` to `tailwind.input.css`; run `build_css.ps1`.

Copy `server/public/genmodel.js` and `server/public/client.js` (full replacement).
Watch for: a template that throws on an item with `story_id: ''` or sparse fields (preview falls back to a plain
card, so look for `story-fallback` in the rendered preview); `formatBackside` being slow or needing fields not in
`ITEM_FIELDS` (extend that tuple in progress.py).

Optional test: `npm i -D jsdom` then `server/test/client.test.js` (full generate -> swap lifecycle).

## Phase D: manual checks (Windows, real run)

- Generate with engine `lr`: skeleton/dim at once, raw stories within seconds, each desk flips as edited, final swap with no reload.
- Generate with `keyword`: desks stay dim/skeleton, then each appears when edited.
- Kill python mid-run: page restores the last saved edition and shows the failure in `#status`.
- Reload the page mid-run: it re-attaches (panel + preview reappear).
- Embedded in Obsidian (`?embed=1`): links still open via postMessage after the swap.
- `engine=both`: swaps once, after the second job.
- `prefers-reduced-motion`: no animation.

## Phase E (optional, separate PR): the real latency fix

Run the desk editor calls in a `ThreadPoolExecutor(2)`. Needs: a lock around `LLM.requests`/`LLM.models`,
a per-desk failure path instead of `llm = None`, and a check that free-tier rate limits tolerate two concurrent
requests. The progress file already supports it (two desks can have `working: true`; genmodel's bar uses per-desk
start times).

## Known limits

- Bar is honest but approximate: it only jumps on real events; between them it creeps and is capped per segment.
- Preview likes are disabled by design; "queue the like and apply after the swap" is possible (map by pool `id`
  to the new story) but needs the final render to expose the pool id.
- Keyword engine shows no raw stage by design (the editor picks the winners there).
