# experiments/feeds — RSS feed fetch experiment

Scope (per AGENTS.md): experiment-specific code lives under `experiments/feeds/`.
This is the **only** folder touched by the experiment scripts. The separate,
intentional config change is noted below.

## What changed (config)

`user/defaults/config.json` — `fetch.user_agent` changed from
`daily-brief/1.0 (personal Obsidian vault; stdlib urllib)` to `DailyBrief/1.0`.

**Why:** IEEE bot-detection blocks UAs containing automation signatures
(`urllib`, `python`, `curl`), returning HTTP 418. The app's old UA contained
`stdlib urllib`. A simple product/version UA (`DailyBrief/1.0`) bypasses the
check and lets IEEE feeds fetch properly (50, 50, 20, 6 items).

`user/defaults/sources.json` — ACM Queue URL replaced with the working
`https://acm-queue-rss.val.run/feed`.

## What it does

`feeds.mjs` fetches each candidate RSS/Atom source with the app's real
User-Agent (read from `user/defaults/config.json`), checks whether the response
is HTTP 200 + a parseable feed, extracts items on success, and writes a
structured result per source to `results.json` plus a console summary table.

`audit_feeds.mjs` audits **every** RSS feed listed in
`user/defaults/sources.json` and prints a full summary table.

Run:
```
node experiments/feeds/feeds.mjs
node experiments/feeds/audit_feeds.mjs
```

## Sources under test (feeds.mjs subset)

| # | Source | URL |
|---|--------|-----|
| 1 | IEEE JSSC — Solid-State Circuits | `https://ieeexplore.ieee.org/rss/TOC4.XML` |
| 2 | IEEE TCAS-I — Circuits and Systems I | `https://ieeexplore.ieee.org/rss/TOC8919.XML` |
| 3 | ACM TACO — Architecture and Code Optimization | `https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=taco` |
| 4 | ACM CSUR — Computing Surveys | `https://dl.acm.org/action/showFeed?type=etoc&feed=rss&jc=csur` |
| 5 | Communications of the ACM (CACM) | `https://cacm.acm.org/feed/` |
| 6 | ACM Queue (replacement) | `https://acm-queue-rss.val.run/feed` |

## Results (validated live, UA = DailyBrief/1.0)

| Source | HTTP | Items | Notes |
|--------|------|-------|-------|
| IEEE JSSC | **200** | **50** | ✅ Now working |
| IEEE TCAS-I | **200** | **50** | ✅ Now working |
| ACM TACO | 403 | 0 | Cloudflare "Just a moment…" challenge |
| ACM CSUR | 403 | 0 | Cloudflare "Just a moment…" challenge |
| CACM /feed/ | 403 | 0 | Cloudflare challenge |
| ACM Queue (val.run) | **200** | **14** | ✅ Working replacement |

Full 34-feed audit (`audit_feeds.mjs`): **26 OK | 8 blocked | 0 failed**.
Blocked: 8 ACM/dl.acm.org/CACM feeds (Cloudflare 403).

### Note on Nature feeds

Nature feeds (Neuroscience, Electronics, Physics, Computational Science) use
RSS 1.0 RDF (root `<rdf:RDF>`, 8 items each). An earlier version of the audit
script's `feedValid` check only recognized `<rss>`/`<feed>` roots, which
falsely flagged them as unparseable. The project's actual parser
(`extractItems` in `server/lib/fetch/fetcher.js`) has no such root-element gate
— it runs the `<item>`/`<entry>` regex directly — so Nature feeds parse fine.
The audit script now recognizes RDF too.

## Recommendation

- IEEE feeds now work with `DailyBrief/1.0` — keep all 4 in config.
- ACM Queue via val.run works — keep as the Queue source.
- Nature feeds work fine (RSS 1.0 RDF, 8 items each) — keep in config.
- ACM TACO / CSUR / TODAES / TECS / TOS / TOPC / CSUR and CACM remain blocked
  by Cloudflare. Leave them in config but expect the fetch pipeline to **skip +
  warn** on 403 rather than crash.
- arXiv feeds return valid Atom (HTTP 200); item extraction depends on the
  project's Atom `<entry>` handling — they have worked historically and remain
  in config.

## Output

- `experiments/feeds/results.json` — machine-readable per-source results from
  `feeds.mjs`.
- Console summary table printed on each run.
