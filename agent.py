"""Agent subsystem (stdlib only).

OpenRouter chat loop with model fallbacks and retries, JSON extraction with
malformed-response salvage (:func:`extract_json`, :func:`salvage_items`), the
editor user-message builder (:func:`build_user_message`) and the editor result
applier (:func:`apply_editor`).
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

import util

KEY_FILE = Path.home() / ".config" / "openrouter.key"


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
            util.warn(f"could not read free-request quota ({type(e).__name__}); continuing")
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
                }, {
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
                        util.warn(f"model {resp.get('model', model)} returned malformed JSON; recovered "
                                  f"{len(parsed['items'])} items")
                    self.models.append(resp.get("model", model))
                    return parsed
                except urllib.error.HTTPError as e:
                    detail = e.read(500).decode("utf-8", errors="replace").strip()
                    last = f"HTTP {e.code}" + (f": {detail}" if detail else "")
                    util.warn(f"model {model} attempt {attempt + 1}/{c['retries'] + 1} failed: {last}")
                    if e.code == 401:  # bad key: no model can work
                        raise LLMUnavailable(last) from e
                    if e.code in (400, 402, 403, 404):  # this model is unusable; try the next
                        break
                    wait = int(e.headers.get("Retry-After", "0") or 0) if e.code == 429 else 0
                    time.sleep(min(max(wait, 5), 30) if wait else 3)
                except (urllib.error.URLError, TimeoutError, ValueError, KeyError,
                        json.JSONDecodeError) as e:
                    last = f"{type(e).__name__}: {e}"
                    util.warn(f"model {model} attempt {attempt + 1}/{c['retries'] + 1} failed: {last}")
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


def build_user_message(desk_title: str, n: int, cands: list[dict], today: str,
                       keep_cap: int | None = None) -> str:
    slim = [{"id": c["id"], "kind": c["kind"], "subtopic": c["subtopic"], "source": c["source"],
             "source_type": c.get("source_type", "commentary"),
             "age_days": round(c["age_days"], 1), "title": c["title"][:220],
             "snippet": c["snippet"][:600]} for c in cands]
    cap = keep_cap if keep_cap is not None else n
    return (f"Today is {today}. Desk: {desk_title}.\n"
            f"Keep at most {cap} of the candidates below, best first, and write them up per the schema. "
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
