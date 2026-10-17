#!/usr/bin/env python3
"""Daily research brief generator (stdlib only).

    python brief.py                 # full run: fetch -> select -> LLM -> render
    python brief.py --no-llm        # offline edition from raw snippets (no OpenRouter calls)
    python brief.py --no-fetch      # reuse the persisted pool, skip the network fetch
    python brief.py --dry-run       # do everything but do not persist state
    python brief.py --seed 3        # reproducible epsilon-greedy draws

Pipeline: fetch real feeds -> normalize/classify -> merge into persistent pool (state.json)
-> epsilon-greedy select per desk (selection.py) -> LLM edits + summarizes -> render Tailwind
template -> write 05-for-agents/daily-brief/YYYY-MM-DD.html -> persist state.

The model never supplies URLs or items; it only ranks and writes about candidates we fetched.
See README.md for the design.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import html
import json
import math
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

import selection as sel

HERE = Path(__file__).resolve().parent
VAULT = HERE.parent.parent
CACHE = Path.home() / ".cache" / "daily_brief"
KEY_FILE = Path.home() / ".config" / "openrouter.key"
STATE_FILE = HERE / "state.json"
TEMPLATES = HERE / "templates"

UTC = dt.timezone.utc
WARNINGS: list[str] = []
LOG_FILE: Path | None = None


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
    if LOG_FILE:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(msg + "\n")
            f.flush()


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    log(f"warn: {msg}")


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json_atomic(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- fetching

class Fetcher:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._last_semanticscholar = 0.0
        self._semanticscholar_lock = threading.Lock()
        CACHE.mkdir(parents=True, exist_ok=True)

    def get(self, url: str, use_cache: bool = True, headers: dict | None = None) -> str:
        cache_file = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".txt")
        ttl = self.cfg["cache_ttl_hours"] * 3600
        if use_cache and cache_file.exists() and time.time() - cache_file.stat().st_mtime < ttl:
            return cache_file.read_text(encoding="utf-8")
        req = urllib.request.Request(
            url, headers={"User-Agent": self.cfg["user_agent"], **(headers or {})}
        )
        with urllib.request.urlopen(req, timeout=self.cfg["timeout_s"]) as r:
            raw = r.read()
        text = raw.decode("utf-8", errors="replace")
        cache_file.write_text(text, encoding="utf-8")
        return text

    def semanticscholar_throttle(self) -> None:
        with self._semanticscholar_lock:
            wait = (
                self._last_semanticscholar
                + self.cfg["semanticscholar_delay_s"]
                - time.time()
            )
            if wait > 0:
                time.sleep(wait)
            self._last_semanticscholar = time.time()


def strip_html(s: str) -> str:
    s = re.sub(r"<(script|style).*?</\1>", " ", s or "", flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def parse_date(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d.astimezone(UTC)


def canonical_url(url: str) -> str:
    u = urllib.parse.urlsplit(url.strip())
    m = re.match(r"^/(?:abs|pdf)/(.+?)(?:v\d+)?(?:\.pdf)?$", u.path)
    if u.netloc.endswith("arxiv.org") and m:
        return f"https://arxiv.org/abs/{m.group(1)}"
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query)
         if not k.lower().startswith(("utm_", "fbclid", "ref", "source"))]
    path = u.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((u.scheme or "https", u.netloc.lower(), path,
                                    urllib.parse.urlencode(q), ""))


def make_item(
    url, title, snippet, published, source, hint_sub, weight, extra_rel=1.0,
    source_type="researchlike",
):
    url = canonical_url(url)
    return {
        "id": hashlib.sha1(url.encode()).hexdigest()[:12],
        "url": url,
        "title": re.sub(r"\s+", " ", title or "").strip(),
        "snippet": (snippet or "").strip()[:900],
        "published": published.isoformat() if published else None,
        "source": source,
        "source_type": source_type,
        "hint": hint_sub,
        "weight": weight * extra_rel,
    }


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_feed(
    xml_text: str, name: str, weight: float, hint: str | None,
    source_type: str = "researchlike",
) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for node in root.iter():
        if local(node.tag) not in ("item", "entry"):
            continue
        f: dict[str, str] = {}
        link = ""
        for ch in node:
            t = local(ch.tag)
            if t == "link":
                link = link or ch.get("href") or (ch.text or "")
            elif t in ("title", "description", "summary", "content", "encoded",
                       "pubDate", "published", "updated", "date"):
                f.setdefault(t, ch.text or "")
        title = strip_html(f.get("title", ""))
        body = strip_html(f.get("encoded") or f.get("content") or f.get("description") or f.get("summary") or "")
        date = parse_date(f.get("pubDate") or f.get("published") or f.get("updated") or f.get("date"))
        if title and link.startswith("http"):
            out.append(make_item(link, title, body, date, name, hint, weight,
                                 source_type=source_type))
    return out


def fetch_hn(f: Fetcher, spec: dict) -> list[dict]:
    since = int(time.time() - f.cfg["hn_lookback_days"] * 86400)
    qs = urllib.parse.urlencode({
        "query": spec["query"], "tags": "story", "hitsPerPage": 30,
        "numericFilters": f"created_at_i>{since},points>{spec['min_points']}",
    })
    data = json.loads(f.get(f"https://hn.algolia.com/api/v1/search_by_date?{qs}"))
    out = []
    for h in data.get("hits", []):
        url = h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}"
        pts = h.get("points") or 1
        snippet = strip_html(h.get("story_text") or "") or (
            f"Hacker News discussion: {pts} points, {h.get('num_comments', 0)} comments.")
        boost = min(1.0, max(0.6, 0.6 + 0.2 * math.log10(max(pts, 1))))
        out.append(make_item(url, h.get("title", ""), snippet, parse_date(h.get("created_at")),
                             "Hacker News", spec["subtopic"], spec["weight"], boost,
                             spec.get("type", "commentary")))
    return out


def fetch_semanticscholar(
    f: Fetcher, spec: dict
) -> list[dict]:
    limit = spec.get("limit", 12)

    params = urllib.parse.urlencode({
        "query": spec["query"],
        "limit": limit,
        "fields": (
            "title,abstract,url,publicationDate,"
            "year,externalIds"
        ),
    })

    endpoint = (
        "https://api.semanticscholar.org/graph/v1/"
        f"paper/search?{params}"
    )
    f.semanticscholar_throttle()
    data = json.loads(f.get(endpoint))

    out = []
    for item in data.get("data", []):
        title = item.get("title", "")
        if not title:
            continue

        ids = item.get("externalIds") or {}
        arxiv_id = ids.get("ArXiv")

        if arxiv_id:
            url = f"https://arxiv.org/abs/{arxiv_id}"
        else:
            url = item.get("url") or (
                "https://www.semanticscholar.org/paper/"
                f"{item.get('paperId')}"
            )

        date = parse_date(
            item.get("publicationDate")
            or str(item.get("year", ""))
        )

        out.append(make_item(
            url,
            title,
            item.get("abstract") or "",
            date,
            "Semantic Scholar",
            spec["subtopic"],
            spec["weight"],
            source_type=spec.get("type", "researchlike"),
        ))

    return out

def fetch_rss(f: Fetcher, spec: dict) -> list[dict]:
    return parse_feed(
        f.get(spec["url"]), spec["name"], spec["weight"], spec["default_subtopic"],
        spec.get("type", "newslike"),
    )

# Having semanticscholar specific things in this function is bad.
# We should be agnostic and kick that off into a clean separate source processor.
def fetch_all(cfg: dict, src: dict) -> list[dict]:
    f = Fetcher(cfg["fetch"])
    items: list[dict] = []
    stats: dict[str, int] = {}

    def run(label, fn, spec):
        try:
            got = fn(f, spec)
            return label, got, None
        except Exception as e:  # one broken source must never sink the edition
            return label, [], f"{type(e).__name__}: {e}"

    refresh = [sys.executable, str(HERE / "brief.py"), "--refresh-s2"]
    if LOG_FILE:
        refresh.extend(("--log-file", str(LOG_FILE)))
    try:
        options = {
            "cwd": HERE,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.DETACHED_PROCESS
        subprocess.Popen(refresh, **options)
        log(f"Semantic Scholar background refresh started ({len(src.get('semanticscholar', []))} queries)")
    except OSError as e:
        warn(f"could not start Semantic Scholar background refresh ({type(e).__name__}: {e})")

    jobs = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for s in src.get("arxiv", []):
            jobs.append(ex.submit(run, s["name"], fetch_rss, s))
        for s in src.get("hn", []):
            jobs.append(ex.submit(run, f"HN:{s['query']}", fetch_hn, s))
        for s in src.get("rss", []):
            jobs.append(ex.submit(run, s["name"], fetch_rss, s))
        results = [j.result() for j in jobs]
    for label, got, err in results:
        if err:
            warn(f"source {label} failed ({err})")
        stats[label] = len(got)
        items.extend(got)
    log("fetched: " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    return items


def refresh_semanticscholar(cfg: dict, src: dict) -> None:
    fetcher = Fetcher(cfg["fetch"])
    for spec in src.get("semanticscholar", []):
        try:
            items = fetch_semanticscholar(fetcher, spec)
            log(f"Semantic Scholar refreshed {spec['name']}: {len(items)} items")
        except Exception as e:
            warn(f"Semantic Scholar source {spec['name']} failed ({type(e).__name__}: {e})")
    log("Semantic Scholar background refresh complete")


# --------------------------------------------------------------------------- classification

_TERM_CACHE: dict[str, re.Pattern] = {}


def _term_regex(term: str) -> re.Pattern:
    """Word-start match; short terms (<= 4 chars, e.g. 'eda', 'dse', 'cim') must be whole words.
    Longer terms may be stems ('cosmolog', 'superconduct')."""
    p = _TERM_CACHE.get(term)
    if p is None:
        body = re.escape(term)
        p = re.compile(r"(?<![a-z0-9])" + body + (r"(?![a-z0-9])" if len(term) <= 4 else ""))
        _TERM_CACHE[term] = p
    return p


def classify(item: dict, keywords: dict, subtopic_to_desk: dict) -> dict | None:
    """Assign subtopic + rel in (0,1]. Returns None for off-topic items."""
    title = item["title"].lower()
    body = item["snippet"].lower()
    scores: dict[str, float] = {}
    for sub, terms in keywords.items():
        h = 0.0
        for t in terms:
            pat = _term_regex(t)
            if pat.search(title):
                h += 2
            elif pat.search(body):
                h += 1
        if h:
            scores[sub] = h
    hint = item["hint"]
    if hint and hint in keywords:
        # A source's own topical hint wins ties and acts as a mild prior.
        scores[hint] = scores.get(hint, 0) + 1.0
    if not scores:
        return None
    sub = max(scores, key=scores.get)
    hits = scores[sub]
    only_hint = hint == sub and hits <= 1.0
    kw = 0.3 if only_hint else min(1.0, hits / 4)
    if not hint and hits < 2:  # untargeted feed with a stray single keyword: skip
        return None
    item["subtopic"] = sub
    item["desk"] = subtopic_to_desk[sub]
    item["rel"] = round(max(0.05, min(1.0, item["weight"] * (0.3 + 0.7 * kw))), 4)
    return item


# --------------------------------------------------------------------------- state / pool

def load_state() -> dict:
    return load_json(STATE_FILE, {"version": 1, "items": {}, "editions": {}})


def merge_pool(state: dict, fresh: list[dict], now: dt.datetime, max_age: float,
               dropped_ids: set[str] = frozenset()) -> int:
    added = 0
    pool = state["items"]
    for iid in dropped_ids:  # fetched again but no longer classified as relevant
        pool.pop(iid, None)
    for it in fresh:
        old = pool.get(it["id"])
        if old:
            # Re-fetched items are reclassified so keyword fixes take effect on existing pool entries.
            old["rel"], old["subtopic"], old["desk"] = it["rel"], it["subtopic"], it["desk"]
            old["source_type"] = it.get("source_type", "commentary")
            if not old.get("snippet") and it["snippet"]:
                old["snippet"] = it["snippet"]
            continue
        pool[it["id"]] = {
            **{k: it[k] for k in ("id", "url", "title", "snippet", "published", "source",
                                  "source_type", "subtopic", "desk", "rel")},
            "first_seen": now.isoformat(), "times_shown": 0, "rejected": 0, "last_shown": None,
        }
        added += 1
    for iid in list(pool):
        if age_days(pool[iid], now) > max_age:
            del pool[iid]
    return added


def age_days(item: dict, now: dt.datetime) -> float:
    d = parse_date(item.get("published")) or parse_date(item.get("first_seen")) or now
    return max(0.0, (now - d).total_seconds() / 86400)


def rollback_same_day(state: dict, date_key: str) -> None:
    """Re-running on the same day must not count the earlier edition as 'already shown'."""
    prev = state["editions"].get(date_key)
    if not prev:
        return
    for iid in prev.get("ids", []):
        it = state["items"].get(iid)
        if it and it["times_shown"] > 0:
            it["times_shown"] -= 1
    for iid in prev.get("rejected_ids", []):
        it = state["items"].get(iid)
        if it and it["rejected"] > 0:
            it["rejected"] -= 1


# --------------------------------------------------------------------------- LLM

class LLMUnavailable(Exception):
    pass


class LLM:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.requests = 0
        self.models: list[str] = []
        self.key = self._load_key()

    @staticmethod
    def _load_key() -> str:
        k = os.environ.get("OPENROUTER_API_KEY") or (
            KEY_FILE.read_text(encoding="utf-8").strip() if KEY_FILE.exists() else "")
        if not k:
            raise LLMUnavailable(f"no API key (env OPENROUTER_API_KEY or {KEY_FILE})")
        return k

    def _http(self, url: str, body: dict | None = None, timeout: int = 30) -> tuple[dict, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if body else "GET", headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json",
            "X-Title": "obsidian-daily-brief"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")), dict(r.headers)

    def remaining_daily(self) -> int | None:
        try:
            d, _ = self._http("https://openrouter.ai/api/v1/key")
            return d["data"]["free_model_daily_requests"]["remaining"]
        except Exception as e:
            warn(f"could not read free-request quota ({type(e).__name__}); continuing")
            return None

    def chat(self, system: str, user: str) -> dict:
        """Try configured models in order, retrying each before using its fallback."""
        c = self.cfg
        models = c.get("models") or [c.get("model")]
        models = [model for model in models if model]
        if not models:
            raise LLMUnavailable("no models configured")
        last = "unknown"
        for model in models:
            body = {
                "model": model, 
                "temperature": c["temperature"], 
                "max_tokens": c["max_tokens"],
                "response_format": {
                        "type": "json_object"
                },
                "reasoning": {
                        "effort": c["effort"],
                },
                "messages": [{   
                        "role": "system", 
                        "content": system 
                },{     
                        "role": "user", 
                        "content": user
                }]}
            for attempt in range(c["retries"] + 1):
                if self.requests >= c["max_requests_per_run"]:
                    raise LLMUnavailable(f"per-run request cap reached ({last})")
                self.requests += 1
                try:
                    resp, _ = self._http(
                        "https://openrouter.ai/api/v1/chat/completions", body, c["timeout_s"]
                    )
                    choices = resp.get("choices") or []
                    if not choices:
                        raise ValueError(
                            f"response has no choices (response_id={resp.get('id', '?')}, "
                            f"model={resp.get('model', model)}, keys={sorted(resp.keys())})"
                        )
                    choice = choices[0]
                    message = choice.get("message") or {}
                    content = (message.get("content") or "").strip()
                    if not content:
                        raise ValueError(
                            f"empty content (response_id={resp.get('id', '?')}, "
                            f"model={resp.get('model', model)}, "
                            f"finish_reason={choice.get('finish_reason')!r}, "
                            f"refusal={message.get('refusal')!r}, usage={resp.get('usage')!r})"
                        )
                    parsed = extract_json(content)
                    if parsed.get("_salvaged"):
                        warn(f"model {resp.get('model', model)} returned malformed JSON; recovered "
                             f"{len(parsed['items'])} items")
                    self.models.append(resp.get("model", model))
                    return parsed
                except urllib.error.HTTPError as e:
                    detail = e.read(500).decode("utf-8", errors="replace").strip()
                    last = f"HTTP {e.code}" + (f": {detail}" if detail else "")
                    warn(f"model {model} attempt {attempt + 1}/{c['retries'] + 1} failed: {last}")
                    if e.code == 401:  # bad key: no model can work
                        raise LLMUnavailable(last) from e
                    if e.code in (400, 402, 403, 404):  # this model is unusable; try the next
                        break
                    wait = int(e.headers.get("Retry-After", "0") or 0) if e.code == 429 else 0
                    time.sleep(min(max(wait, 5), 30) if wait else 3)
                except (urllib.error.URLError, TimeoutError, ValueError, KeyError,
                        json.JSONDecodeError) as e:
                    last = f"{type(e).__name__}: {e}"
                    warn(f"model {model} attempt {attempt + 1}/{c['retries'] + 1} failed: {last}")
                    body["messages"][-1]["content"] = user + (
                        "\n\nIMPORTANT: your previous reply was not valid JSON. Reply with ONE valid JSON "
                        "object only, no prose. Keep each blurb to two short sentences.")
                    time.sleep(3)
        raise LLMUnavailable(f"all configured models failed ({last})")


def _balanced_objects(text: str):
    """Yield every balanced {...} substring (any depth), respecting JSON strings."""
    stack: list[int] = []
    in_str = esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            stack.append(i)
        elif ch == "}" and stack:
            yield text[stack.pop():i + 1]


def salvage_items(text: str) -> dict | None:
    """Recover individually valid item objects from malformed or truncated model JSON."""
    items = []
    for chunk in _balanced_objects(text):
        try:
            d = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and "id" in d and ("headline" in d or d.get("keep") is False):
            items.append(d)
    if not items:
        return None
    m = re.search(r'"deck"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    lead = re.search(r'"lead_id"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    return {"deck": m.group(1) if m else "", "lead_id": lead.group(1) if lead else "", "items": items,
            "_salvaged": True}


def extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        i, j = text.find("{"), text.rfind("}")
        if i >= 0 and j > i:
            try:
                return json.loads(text[i:j + 1])
            except json.JSONDecodeError:
                pass
        s = salvage_items(text)
        if s:
            return s
        raise


def build_user_message(desk_title: str, n: int, cands: list[dict], today: str) -> str:
    slim = [{"id": c["id"], "kind": c["kind"], "subtopic": c["subtopic"], "source": c["source"],
             "source_type": c.get("source_type", "commentary"),
             "age_days": round(c["age_days"], 1), "title": c["title"][:220],
             "snippet": c["snippet"][:600]} for c in cands]
    return (f"Today is {today}. Desk: {desk_title}.\n"
            f"Keep at most {n} of the candidates below, best first, and write them up per the schema. "
            "Include at least one newslike candidate when one is available. "
            f"Candidates are listed in the editor's suggested order but you may reorder by importance.\n\n"
            f"CANDIDATES:\n{json.dumps(slim, ensure_ascii=False, indent=1)}")


def _clip(v, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def apply_editor(cands: list[dict], result: dict | None, n: int) -> tuple[list[dict], list[str], str]:
    """Turn model output (or None) into final stories. Returns (stories, rejected_ids, deck)."""
    by_id = {c["id"]: c for c in cands}
    stories: list[dict] = []
    rejected: list[str] = []
    deck = ""
    seen: set[str] = set()
    if result:
        deck = _clip(result.get("deck"), 220)
        for e in result.get("items", []) if isinstance(result.get("items"), list) else []:
            if not isinstance(e, dict):
                continue
            iid = str(e.get("id", ""))
            c = by_id.get(iid)
            if not c or iid in seen:
                continue
            seen.add(iid)
            if e.get("keep") is False:
                rejected.append(iid)
                continue
            head, blurb = _clip(e.get("headline"), 140), _clip(e.get("blurb"), 650)
            if not head or not blurb:
                continue
            try:
                sig = max(1, min(5, int(e.get("significance", 3))))
            except (TypeError, ValueError):
                sig = 3
            tags = [_clip(t, 24) for t in (e.get("tags") or [])[:3] if isinstance(t, str) and t.strip()]
            stories.append({**c, "headline": head, "blurb": blurb, "why_care": _clip(e.get("why_care"), 170),
                            "tags": tags, "significance": sig, "summarized": True})
    # Backfill with raw candidates the editor did not explicitly reject.
    if len(stories) < n:
        have = {s["id"] for s in stories}
        for c in cands:
            if len(stories) >= n:
                break
            if c["id"] in have or c["id"] in rejected:
                continue
            stories.append({**c, "headline": c["title"][:140], "blurb": c["snippet"][:320] or "No summary available.",
                            "why_care": "", "tags": [c["subtopic"]], "significance": 1, "summarized": False})
    stories = stories[:n]
    if result and stories:
        lead = str(result.get("lead_id", ""))
        stories.sort(key=lambda s: 0 if s["id"] == lead else 1)  # stable: lead first
        if stories[0]["id"] != lead:
            stories.sort(key=lambda s: -s["significance"])
    return stories, rejected, deck


# --------------------------------------------------------------------------- rendering

class Raw(str):
    pass


def fill(tpl: str, **vals) -> str:
    def esc(v):
        return v if isinstance(v, Raw) else html.escape(str(v), quote=True)
    return re.sub(r"\{\{(\w+)\}\}", lambda m: esc(vals.get(m.group(1), "")), tpl)


def tpl(name: str) -> str:
    return (TEMPLATES / name).read_text(encoding="utf-8")


def age_label(s: dict) -> str:
    d = s["age_days"]
    if d < 1:
        return "today"
    if d < 2:
        return "yesterday"
    if d < 14:
        return f"{int(d)} days ago"
    if d < 60:
        return f"{int(d // 7)} weeks ago"
    return f"{int(d // 30)} months ago"


def safe_url(u: str) -> str:
    return u if u.startswith(("http://", "https://")) else "#"


def render_story(s: dict, lead: bool) -> str:
    tags = Raw("".join(fill(tpl("tag.html"), tag=t) for t in s["tags"]))
    badge = Raw(fill(tpl("badge.html"), label="From the archive")) if s["kind"] == "archive" else Raw("")
    why = Raw(fill(tpl("why.html"), why=s["why_care"])) if s["why_care"] else Raw("")
    raw_note = Raw("" if s["summarized"] else fill(tpl("badge.html"), label="Unedited"))
    return fill(tpl("lead.html" if lead else "story.html"),
                headline=s["headline"], blurb=s["blurb"], url=safe_url(s["url"]), source=s["source"],
                age=age_label(s), tags=tags, badge=badge, why=why, raw_note=raw_note)


def render_desk(stories: list[dict]) -> str:
    return "".join(render_story(s, lead=(i == 0)) for i, s in enumerate(stories))


def render_page(cfg: dict, now: dt.datetime, edition_no: int, desks: dict, meta: dict) -> str:
    css = (HERE / "tailwind.css").read_text(encoding="utf-8")
    local_now = now.astimezone()
    foot = (f"Edited by {meta['model']}. {meta['n_fresh']} recent, {meta['n_archive']} from the archive. "
            f"{meta['n_explore']} explore picks (epsilon {meta['epsilon']}). "
            f"Candidate pool: {meta['pool']} items. Sources: {meta['sources']}.")
    warn_html = Raw("".join(fill(tpl("warning.html"), text=w) for w in WARNINGS[:6]))
    return fill(
        tpl("page.html"),
        css=Raw(css), paper_name=cfg["paper_name"],
        date_long=local_now.strftime("%A, %B %d, %Y").replace(" 0", " "),
        edition=f"No. {edition_no}",
        generated=local_now.strftime("%H:%M"),
        primary_title=desks["primary"]["title"], primary_deck=desks["primary"]["deck"],
        primary_stories=Raw(render_desk(desks["primary"]["stories"])),
        science_title=desks["science"]["title"], science_deck=desks["science"]["deck"],
        science_stories=Raw(render_desk(desks["science"]["stories"])),
        warnings=warn_html, footer=foot,
    )


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--out", help="override output path")
    ap.add_argument("--refresh-s2", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--log-file", type=Path, help=argparse.SUPPRESS)
    args = ap.parse_args()
    global LOG_FILE
    LOG_FILE = args.log_file

    cfg = load_json(HERE / "config.json")
    src = load_json(HERE / "sources.json")
    if args.refresh_s2:
        refresh_semanticscholar(cfg, src)
        return 0
    if not (HERE / "tailwind.css").exists():
        log("tailwind.css missing. Run build_css.ps1 once (see README).")
        return 1
    scfg = {**sel.DEFAULTS, **cfg["selection"]}
    rng = random.Random(args.seed)
    now = dt.datetime.now(UTC)
    date_key = now.astimezone().strftime("%Y-%m-%d")
    sub2desk = {s: d for d, v in src["desks"].items() for s in v["subtopics"]}

    state = load_state()
    rollback_same_day(state, date_key)

    source_types = {
        spec["name"]: spec.get("type", default_type)
        for key, default_type in (("arxiv", "researchlike"), ("semanticscholar", "researchlike"),
                                  ("hn", "commentary"), ("rss", "newslike"))
        for spec in src.get(key, [])
    }
    source_types["Hacker News"] = "commentary"
    source_types["Semantic Scholar"] = "researchlike"
    for item in state["items"].values():
        item.setdefault("source_type", source_types.get(item["source"], "commentary"))

    # 1. fetch + classify + merge
    if args.no_fetch:
        log("skipping fetch; using persisted pool")
    else:
        raw = fetch_all(cfg, src)
        classified, seen, dropped = [], {}, set()
        for it in raw:
            c = classify(it, src["keywords"], sub2desk)
            if c is None:
                dropped.add(it["id"])
            elif c["id"] not in seen or c["rel"] > seen[c["id"]]["rel"]:
                seen[c["id"]] = c
        classified = list(seen.values())
        added = merge_pool(state, classified, now, cfg["pool"]["max_age_days"], dropped - set(seen))
        log(f"classified {len(classified)}/{len(raw)} items, {added} new in pool")
    pool = list(state["items"].values())
    if not pool:
        log("pool is empty (all sources failed?)")
        return 1
    for p in pool:
        p["age_days"] = age_days(p, now)

    # 2. epsilon-greedy selection per desk
    n, k = cfg["stories_per_desk"], cfg["reserve_per_desk"]
    selected: dict[str, list[dict]] = {}
    modes = {"explore": 0, "greedy": 0}
    for desk, spec in src["desks"].items():
        cands_all = [p for p in pool if p["subtopic"] in spec["subtopics"]]
        picks = sel.pick_desk(cands_all, spec["subtopics"], n, scfg, rng,
                              minimum_types={"newslike": 1})
        for item, mode in picks:
            modes[mode] += 1
        chosen = [dict(i, mode=m) for i, m in picks]
        reserve = [dict(i, mode="reserve") for i in sel.pick_reserves(
            cands_all, {i["id"] for i, _ in picks}, k, scfg,
            minimum_types={"newslike": 1},
        )]
        selected[desk] = chosen + reserve
        for c in selected[desk]:
            c["kind"] = sel.kind_of(c, scfg)
        log(f"{desk}: {len(chosen)} picked ({sum(1 for _, m in picks if m == 'explore')} explore) + {len(reserve)} reserve")

    # 3. LLM edit
    llm: LLM | None = None
    if not args.no_llm:
        try:
            llm = LLM(cfg["llm"])
            rem = llm.remaining_daily()
            if rem is not None and rem < cfg["llm"]["min_remaining_daily"]:
                raise LLMUnavailable(f"only {rem} free requests left today")
        except LLMUnavailable as e:
            warn(f"LLM skipped: {e}. Showing an unedited edition.")
            llm = None
    desks_out, all_rejected, shown_ids = {}, [], []
    today_s = now.astimezone().strftime("%A %Y-%m-%d")
    system = (HERE / "prompt_system.md").read_text(encoding="utf-8")
    for desk, spec in src["desks"].items():
        result = None
        if llm:
            try:
                result = llm.chat(system, build_user_message(spec["title"], n, selected[desk], today_s))
            except LLMUnavailable as e:
                warn(f"{spec['title']}: editor unavailable ({e}); showing raw items")
                if "cap" in str(e) or "HTTP 401" in str(e):
                    llm = None
        stories, rejected, deck = apply_editor(selected[desk], result, n)
        desks_out[desk] = {"title": spec["title"], "stories": stories,
                           "deck": deck or "Unedited candidates, ranked by relevance and freshness."}
        all_rejected += rejected
        shown_ids += [s["id"] for s in stories]

    # 4. render
    out_dir = VAULT / cfg["edition_dir"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else out_dir / f"{date_key}.html"
    all_stories = [s for d in desks_out.values() for s in d["stories"]]
    edition_no = len(set(state["editions"]) | {date_key})
    models = sorted(set(llm.models)) if llm and llm.models else []
    meta = {
        "model": ", ".join(models) if models else "no model (raw items)",
        "n_fresh": sum(s["kind"] == "fresh" for s in all_stories),
        "n_archive": sum(s["kind"] == "archive" for s in all_stories),
        "n_explore": sum(s.get("mode") == "explore" for s in all_stories),
        "epsilon": scfg["epsilon"], "pool": len(pool),
        "sources": ", ".join(sorted({s["source"].split(":")[0] for s in all_stories})),
    }
    page = render_page(cfg, now, edition_no, desks_out, meta)
    out_path.write_text(page, encoding="utf-8")

    # 5. persist state only after a successful write
    if not args.dry_run:
        for iid in shown_ids:
            it = state["items"].get(iid)
            if it:
                it["times_shown"] += 1
                it["last_shown"] = now.isoformat()
        for iid in all_rejected:
            if iid in state["items"]:
                state["items"][iid]["rejected"] += 1
        state["editions"][date_key] = {"ids": shown_ids, "rejected_ids": all_rejected,
                                       "generated": now.isoformat(), "model": meta["model"],
                                       "llm_requests": llm.requests if llm else 0}
        save_json_atomic(STATE_FILE, state)
    print(f"OK {out_path} ({len(all_stories)} stories, model={meta['model']}, "
          f"llm_requests={llm.requests if llm else 0})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # surface a one-line error for the Obsidian button
        log(f"FAILED: {type(e).__name__}: {e}")
        raise