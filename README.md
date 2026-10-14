# Daily Brief

A "front page" of research news, regenerated on demand and embedded in `01_Projects/Home.md`.
Real items are fetched by Python; a free OpenRouter model only **ranks and summarizes** them. The
output is a self-contained Tailwind HTML file per day.

```
daily_brief/
  brief.py             orchestrator (stdlib only)
  selection.py         epsilon-greedy + soft staleness (pure functions)
  config.json          every tunable (epsilon, a50, slope, desk sizes, model, limits)
  sources.json         arXiv queries, HN queries, RSS feeds, subtopic keyword lists
  prompt_system.md     the editor prompt (interests + rules + JSON schema)
  templates/*.html     Tailwind-classed layout (page, lead, story, tag, ...)
  tailwind.input.css   Tailwind entry file       tailwind.css  compiled output (committed)
  build_css.ps1        one-off Tailwind build
  state.json           pool of items + what has been shown (gitignored, Syncthing-synced)
  test_selection.py    assertions + simulation   test_brief.py  parser/render tests
  examples/            example how to embed daily brief into obsidian
`edition_dir`/YYYY-MM-DD.html     the editions (newest one is displayed)
~/.config/openrouter.key                      API key (outside the vault)
~/.cache/daily_brief/                         HTTP cache, 6 h TTL (outside the vault)
```

## Running it

| What | How |
|---|---|
| From Obsidian | Home.md, "Generate brief" / "Regenerate" button (desktop only); open **Logs** to view the live run log |
| From a shell | `python 98-Scripts/daily_brief/brief.py` |
| No network LLM | `--no-llm` (raw items, no OpenRouter calls) |
| Reuse the pool | `--no-fetch` |
| Don't persist state | `--dry-run` |
| Reproducible draws | `--seed N` |
| Tests | `python test_selection.py --sim` and `python test_brief.py` |

## Pipeline

1. **Fetch** RSS, arXiv, and Hacker News sources in parallel (arXiv is serialized with a 3.1 s gap, per arXiv's API etiquette). Semantic Scholar refreshes run in a detached background process with its own throttle; its HTTP cache is picked up by later runs. One failing source is a warning, never an error.
2. **Classify.** Each item is scored against the keyword lists in `sources.json`
   (title hit = 2, body hit = 1). The best subtopic wins; the source's own hint adds a mild prior.
   Untargeted feeds (IEEE Spectrum, Physics World, ...) need at least 2 hits or the item is dropped.
   `rel` in (0, 1] = `source_weight * (0.3 + 0.7 * min(1, hits/4))`, with a points boost for HN.
3. **Merge into the persistent pool** (`state.json`). Items stay for `pool.max_age_days` (120).
   The pool is what lets a quiet day show something from last week: RSS feeds only expose a few
   days, the pool remembers.
4. **Select** with epsilon-greedy (next section): 5 stories per desk, plus 3 reserves per desk. When available, each desk gets at least one newslike candidate before the editor ranks the set.
5. **Edit.** One LLM call per desk, with configured model fallbacks in order (JSON mode). The model returns headline,
   2 to 3 sentence blurb, a "why you'd care" line, tags, significance, and a lead. URLs and ids
   always come from our candidates, never from the model.
6. **Render** into the Tailwind templates with `html.escape` on every value, inline the compiled
   CSS, write `YYYY-MM-DD.html`.
7. **Persist state** only after the file is written.

### Desks

| Desk | Share | Subtopics |
|---|---|---|
| Silicon & Architecture (primary) | 5 of 10 | `dse`, `accel` (digital + IMC + 3D-stacked), `fab` (fab, packaging, Hot Chips) |
| Science (secondary) | 5 of 10 | `gr`, `qft`, `oshw`, `condmat`, `neuro` |

The half-and-half split is `stories_per_desk` in `config.json`.

## Selection: epsilon-greedy with soft staleness

Goal: show what is fresh, but never run dry. Academic news is lumpy, so on a quiet day the page
should degrade gracefully to last week's and last month's best items, with no hard cutoff.
Implementation: `selection.py`. Simulation: `python test_selection.py --sim`.

### 1. Freshness: a logistic curve in log-age

```
f(a) = sigmoid( (ln a50 - ln a) / s )          a = max(age_in_days, age_floor_days)
```

`a50 = 7` days is the age at which an item is worth half a brand-new one; `s = 1` sets how sharply
that falls off. Using log-age makes one curve behave sensibly across the day, week and month
scales. The floor (6 h) stops sub-hour differences from mattering. `f` never reaches 0, so
nothing is ever excluded outright: that is the "soft cap".

| age | 6 h | 1 d | 3 d | 7 d | 14 d | 30 d | 60 d | 90 d | 180 d |
|---|---|---|---|---|---|---|---|---|---|
| f | 0.97 | 0.88 | 0.70 | 0.50 | 0.33 | 0.19 | 0.10 | 0.07 | 0.04 |

### 2. Item scores

```
penalty        = shown_decay ^ times_shown  *  rejected_decay ^ times_rejected
greedy_score   = rel * f(age) * penalty
explore_weight = rel * f(age)^gamma * penalty
```

- `rel` is the topical relevance from classification (source weight and keyword hits).
- `shown_decay = 0.1`: an item already shown is worth 10x less per previous appearance. This is
  deliberately harsh. With 0.25, a high-scoring yesterday-item (0.88 x 0.25 = 0.22) can typically still beat an unseen month-old item (0.19) and the item will repeat a lot.
- `rejected_decay = 0.3`: items the LLM editor threw out are demoted, not banned.
- `gamma = 0.3` flattens freshness for exploration: the 30-day weight is 0.19^0.3 = 0.61 instead of 0.19, so old items get a real chance when exploring.

### 3. One draw (per story slot)

```
with probability 1 - epsilon:   pick argmax(greedy_score)               # exploit
with probability     epsilon:   sample proportional to explore_weight    # explore
```

`epsilon = 0.25`, so on average 2 to 3 of the 10 slots are exploratory. A greedy draw takes the
best-scoring item, which is usually fresh. An exploratory draw samples from a flatter distribution,
so a week-old or month-old item can win. Anything older than `archive_after_days` (7) is tagged
"From the archive" and the editor is told to frame it as worth revisiting.

### 4. Filling a desk

Each desk picks `stories_per_desk` items one at a time, without replacement. Before every draw the desk's subtopics are ranked by how many stories they already contributed (fewest first, random tie-break) and the draw is restricted to the first subtopic that still has candidates:

- 5 slots over the 3 primary subtopics gives 2/2/1, and the extra slot rotates randomly.
- 5 slots over the 5 science subtopics gives one each, if each has candidates.
- A subtopic with no candidates is skipped, so a quiet field never leaves a hole.

Epsilon-greedy therefore operates *within* a subtopic, and the rotation guarantees breadth.

### 5. Reserves, rejections and re-runs

- `reserve_per_desk` extra top-scoring items are sent to the editor as backfill. If it rejects an item (`keep: false`) the next reserve takes its place. If the model fails entirely, the raw items are shown, marked "Unedited".
- After a successful write, shown items get `times_shown += 1` and rejected items `rejected += 1`.
- Re-running on the same day first subtracts that day's previous increments, so regenerating does not make the day's own stories look "already seen".

### 6. What the simulation shows

`python test_selection.py --sim` runs 150 synthetic days (first 30 discarded) with the real selector and config. With rich feeds (2 to 5 relevant items a day per subtopic): about 58% of picks are under a day old, 75% under 3 days, about 11% older than 30 days, about 25% are explore draws and about 2% are repeats. With sparse feeds (under 1 item a day for `gr`, `qft`, `dse`) the page leans on older material and about a third of slots are repeats, because consumption exceeds arrival. That is the signal to add sources for those subtopics, not to loosen the selector.

### Tuning

| Want | Change |
|---|---|
| More surprise / more old items | raise `epsilon` (0.25 to 0.4) or `explore_gamma` toward 0 |
| Fresher front page | lower `a50_days` (7 to 3) or `epsilon` |
| Sharper day/week/month cliff | lower `slope` (1 to 0.6) |
| Fewer repeats | lower `shown_decay` |
| Fewer "archive" labels | raise `archive_after_days` |

## TODO: feedback loop (not implemented)

Today `rel` comes only from static source weights and keyword hits, so the system cannot learn what
you actually care about. Planned, in order of effort:

1. **Capture signals.** Log link clicks from the iframe (the click handler in Home.md already intercepts them) and an optional per-story "more like this / less like this" control into `state.json` (`clicks`, `thumbs`).
2. **Vault signal.** Treat any item you later `#reading`-tag, link to from a note, or add to `DSE Current.md` as a strong positive. A script can scan the vault for brief URLs.
3. **Online weights.** Maintain per-source and per-subtopic multipliers, and per-keyword weights, updated with a small learning rate from the signals above and decayed over time. Feed them into `rel`. The existing `epsilon` exploration keeps the learner from collapsing onto one topic.
4. **Bandit view.** Treat each subtopic as an arm with a click-through reward and replace the fixed round-robin by Thompson sampling, keeping a minimum quota per desk.
5. **Sidecar output.** Emit a `.md` list of the day's links so picks can flow into the Tasks `#reading` list and the Daily Board plan.

## TODO: embedding model-based rel scores

Similar to the embedding model used in Obsidian Smart Connections, we can use an embedding model to replace keyword relevance `rel` scores.

This also means we can use K-means clustering on the obsidian notes in order to get candidate "interest vectors".

Then, we can edit the feedback loop to add weights favoring specific interest vectors over others.

Interest vectors have two sources of weight: the number of notes that contribute to this interest, and the user feedback. User feedback likely has to have more weight, else interest vectors will have 

See [notes](notes.md) for more on this.

## Other TODO

- Proper logging file in `daily-brief/logs`
- Performance benchmarking (`test_perf.py`)

## Limits, caveats, operations

- **Free tier:** 20 requests/min and 50/day (1000/day after buying 10 credits). A normal run uses
  2 successful requests normally; model fallbacks and retries are capped by
  `llm.max_requests_per_run` (24). The script reads
  `GET /api/v1/key` first and skips the LLM when fewer than `min_remaining_daily` remain.
- **Model quality varies.** The configured Nemotron models are attempted in order, followed by
  `openrouter/free`. The parser salvages valid items from malformed JSON, retries with a correction,
  and finally falls back to raw items. The footer lists which model(s) wrote the page.
- **Logs are temporary.** The Obsidian embed's Logs popup shows live generator output. Its temporary
  log is removed when both the edition and background Semantic Scholar refresh finish.
- **Privacy:** only public feed text is sent to the model, never vault notes.
- **Untrusted text:** feed content is escaped before rendering, only http(s) URLs are linked, and
  the prompt tells the model to ignore instructions embedded in items.
- **Tailwind:** compiled once with the standalone CLI (`~/.config/tailwind/tailwindcss.exe`, outside
  the vault). Daily runs never rebuild it. Re-run `build_css.ps1` only after adding utility classes
  to `templates/` or `brief.py`. Note that `.obsidian/snippets/home-dashboard.css` is hand-written CSS
  (Tailwind's colour values, no Tailwind build), so it cannot be reused for the iframe.
- **Syncthing:** `state.json` syncs between machines. Do not generate on two machines at once.
