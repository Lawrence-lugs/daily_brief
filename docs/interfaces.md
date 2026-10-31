# Interfaces: Electron, Obsidian, and Web

The Daily Brief is **desktop-only**: it runs a localhost Node server and is consumed through an Electron window or
an Obsidian iframe. Both entry points load the **same URL** (`http://127.0.0.1:4873/`) and therefore show the **same
brief and the same like/save marks**.

There is no mobile support and no GitHub Pages deployment. External links open in the system browser.

---

## 1. Shared Foundation: the Localhost Server

`server/index.js` starts an HTTP server on `http://127.0.0.1:4873/` (never a public interface). It exits 0
immediately if a server is already answering `/api/health`, so every entry point reuses a single running instance.

### Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/health` | GET | `{ ok: true, name: 'daily-brief' }` — also used for the "already running" check |
| `/api/briefs` | GET | List generated briefs (with `meta.engine`) |
| `/api/job` | GET | Background job status (queued/running/done/failed) |
| `/api/generate` | POST | Spawn `python src/brief.py` to generate a new brief |
| `/api/shutdown` | POST | Shut down the server |
| `/api/stories/<id>/feedback` | POST | Toggle `liked`/`saved` on a story (feeds ranker training labels) |
| `/api/export/training.jsonl` | GET | Export `training_examples` as JSONL |
| `/archive` | GET | Render the stories archive page (`list.html`) |
| `/api/stories` | GET | Paged, filtered list of stories (params: q, mark, desk, subtopic, source, tag, from, to, sort, limit, offset) |
| `/api/stories/facets` | GET | Facet counts for desk, subtopic, source, tag (for filter dropdowns) |

The server renders HTML/Tailwind via `server/lib/render.js` and persists like/save via `server/public/client.js`.

---

## 2. Electron (`electron/main.cjs`)

**Run:** `npx electron electron/main.cjs` (or `npm run app`).

- Spawns the Node server (`node server/index.js --port 4873`) as a **separate system `node` process** if it isn't
  already healthy. This keeps `node:sqlite` out of Electron's bundled Node runtime.
- Opens a `BrowserWindow` (1280×900) loading `http://127.0.0.1:4873/`.
- External links (`^https?:`) are opened in the system browser via `shell.openExternal`; navigation away from the
  origin is redirected externally.
- Closing the window stops **only** a server that Electron itself started — never a pre-existing one (`app.on('window-all-closed')` kills the spawned child).

### Behavior notes

- If you already started the server manually (`npm run serve`), Electron attaches to it and does not spawn a
  second one.
- Server logs are inherited (`stdio: 'inherit'`) so you see them in the Electron console.

---

## 3. Obsidian (`obsidian/daily-brief.md`)

**Run:** Open `obsidian/daily-brief.md` in Obsidian (desktop). The dataviewjs block:

1. Refuses to run on mobile (`app.isMobile`) — desktop only.
2. Polls `/api/health`; if the server isn't healthy, spawns `node server/index.js` detached (`child.unref()`,
   `stdio: "ignore"`).
3. Creates an `<iframe>` with `src = http://127.0.0.1:4873/?embed=1&theme=<dark\|light>`.
   - `allow-same-origin allow-scripts` sandbox so the iframe's own localhost origin can fetch/POST.
   - `width:100%;height:85vh;border:0;border-radius:12px`.
4. Syncs theme: a `MutationObserver` watches `document.body.classList` for `theme-dark` and `postMessage`s
   `{ type: "theme", theme }` to the iframe.
5. Listens for `open-url` messages from the iframe and opens them in the system browser via `electron.shell`.

### Behavior notes

- The iframe and the Electron window show the identical brief because they hit the same server + DB.
- Like/save marks persist in `stories` and are shared across both interfaces.
- Do not sync `daily_brief.db` (or its WAL/SHM files) through Obsidian Sync / Syncthing — SQLite WAL corrupts under
  file sync. Use an absolute `db_file` outside any synced vault.

---

## 4. Web (localhost only)

There is no separate "web" build. The **web interface is the localhost server itself**, rendered by
`server/lib/render.js` with Tailwind classes:

- `templates/page.html` — shell (head, theme toggle, desks)
- `templates/lead.html` — lead story of each desk
- `templates/story.html` — individual story card (headline, blurb, why_care, tags, significance)
- `templates/tag.html` — topic tag badges
- `templates/badge.html` — mode/explore/reserve badges
- `templates/why.html` — "why care" explainer

`server/public/client.js` handles:
- Like/save persistence (POST to `/api/stories/<id>/feedback` with `{ action: "like"\|"save", value: boolean }`)
- Generate button + logs (POST to `/api/generate`, SSE/polling for job status)
- Theme toggle (dark/light, synced to Obsidian via postMessage)
- Embed bridge (receives theme messages from the Obsidian iframe)

The frontend talks only to `http://127.0.0.1:4873`; there is no external CDN dependency except Tailwind (compiled
once via `build_css.ps1` into `tailwind.css`, committed).

---

## 5. Entry-Point Comparison

| | Electron | Obsidian | Manual (`npm run serve`) |
|---|----------|----------|--------------------------|
| URL loaded | `http://127.0.0.1:4873/` | `http://127.0.0.1:4873/?embed=1&theme=...` | `http://127.0.0.1:4873/` |
| Starts server if needed | Yes (spawned child) | Yes (detached child) | No (you start it) |
| Stops server on close | Only its own spawned server | No (detached, unref'd) | N/A |
| Like/save shared | ✅ | ✅ | ✅ |
| Theme sync | Native dark/light | Via postMessage from vault | Native dark/light |
| Mobile | No | No | No |

---

## 6. How a Like/Save Flows Through the Interfaces

```
User clicks like in Electron or Obsidian iframe
        │
        ▼
client.js POST /api/stories/<id>/feedback  { action: "like"|"save", value: boolean }
        │
        ▼
server/app.js  →  queries.setFeedback()  →  stories.liked / stories.saved
        │
        ▼
Next ranker run reads liked/saved via store.likedIds (SQL)
        │
        ▼
Liked items feed Ward medoid construction + training labels (ranker_state)
```

This is why like/save marks are the ranker's training signal: they flow from the UI into `stories`, then into
`interests.js` (medoids) and `trainer.js` (labels).

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Brief server did not start" | Node not on PATH, or port 4873 blocked | Ensure `node ≥ 22.13`; check `BRIEF_PORT` env |
| Obsidian iframe blank on mobile | `app.isMobile` guard | Desktop only — use the desktop Obsidian app |
| Like/save not persisting | Server not running, or DB locked | Confirm `/api/health` answers; close other writers |
| External links open inside iframe | `will-navigate` handler missing | Electron main.cjs redirects `!startsWith(ORIGIN)` to `shell.openExternal` |
| Theme not syncing in Obsidian | MutationObserver not attached | `dv.component.register` cleanup; reload the note |
| Two servers fighting | Both Electron and manual `npm run serve` | Fine — second `index.js` exits 0 via alreadyRunning check |

---

## 8. Related Docs

| Topic | File |
|-------|------|
| Project architecture & call paths | `docs/architecture.md` |
| Bayesian LR + Ward clustering model | `docs/model.md` |
| SQLite-based stateful logging | `docs/sqlite-logging.md` |
| Experiments & simulate functionality | `docs/experiments.md` |
| Ranker CLI reference | `ranker/README.md` |
| Full tunable configuration | `config.json` |
