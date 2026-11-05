#!/usr/bin/env python3
"""Cross-language performance profiler for the daily brief.

Usage:
    python tools/profile_brief.py [options]

What it does
------------
1. Python side: runs ``python -m cProfile src/brief.py --dry-run --no-llm
   --no-fetch`` and reports the hottest Python functions (cumulative CPU time).

2. JS side: runs ``node --prof ranker/cli.js select --date <today>`` then
   ``node --prof-process`` and reports the hottest JS functions (V8 CPU time).

Why both sides
--------------
``src/brief.py`` shells out to the Node ranker (``ranker/cli.js select``)
inside :func:`select_lr`. cProfile sees that as a single ``subprocess.run()``
call and cannot see inside Node. Conversely, profiling Node alone misses all
the Python work (fetch, classify, DB, keyword selection, LLM). This script
profiles both and prints a combined report.

In production the client skips Python entirely and calls the Node ranker
directly, so the JS profile is the prod-relevant hot path.

Profiling config
----------------
The default brief command is offline (``--no-llm --no-fetch``) so profiling is
reproducible without network or OpenRouter. That default deliberately *skips*
the two network-heavy stages (fetch and LLM), so it will *not* surface their
latency.

To profile the real, latency-heavy path (network fetch + LLM edits), drop those
flags:

    python tools/profile_brief.py --brief-args

This runs ``brief.py --dry-run`` with fetch and LLM enabled. It requires
network access and an OpenRouter API key, can be slow, and may fail if feeds or
the model endpoint are unavailable. Pass extra brief flags after ``--brief-args``
if needed (e.g. ``--brief-args --seed 3``). ``--dry-run`` is added automatically.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import os
import pstats
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BRIEF = PROJECT_ROOT / "src" / "brief.py"
RANKER_CLI = PROJECT_ROOT / "ranker" / "cli.js"

DEFAULT_BRIEF_ARGS = ["--dry-run", "--no-llm", "--no-fetch"]


def now_date_key() -> str:
    """Today's date in local tz, matching brief.py's date_key."""
    return dt.datetime.now().astimezone().strftime("%Y-%m-%d")


def sh(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """Run a command, echoing it to stderr for traceability."""
    print(f"[cmd] (cwd={cwd}) {' '.join(cmd)}", file=sys.stderr, flush=True)
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)


# --------------------------------------------------------------------------- Python side

def run_python_profile(brief_args: list[str], out: Path) -> dict:
    """Profile the Python entry with cProfile. Returns a result dict."""
    prof_path = out / "python.prof"
    cmd = [sys.executable, "-m", "cProfile", "-o", str(prof_path), str(BRIEF), *brief_args]
    t0 = time.perf_counter()
    cp = sh(cmd, PROJECT_ROOT)
    wall = time.perf_counter() - t0

    return {
        "prof_path": prof_path,
        "returncode": cp.returncode,
        "stdout": cp.stdout,
        "stderr": cp.stderr,
        "wall": wall,
        "command": " ".join(cmd),
    }


def python_top(prof_path: Path, n: int) -> list[tuple]:
    """Return top-N Python functions by cumulative time."""
    p = pstats.Stats(str(prof_path))
    rows = []
    for (fn, lineno, name), (cc, ncalls, tottime, cumtime, _callers) in p.stats.items():
        rows.append((cumtime, tottime, ncalls, Path(fn).name, lineno, name))
    rows.sort(reverse=True)
    out = []
    for cumtime, tottime, ncalls, fn, lineno, name in rows[:n]:
        out.append((ncalls, round(tottime, 4), round(cumtime, 4),
                    f"{name} ({fn}:{lineno})"))
    return out


# --------------------------------------------------------------------------- JS side

def run_js_profile(date_key: str, seed: int | None, out: Path) -> dict:
    """Profile the Node ranker select with V8 --prof, then --prof-process."""
    js_out = out / "js-profile.txt"
    v8_logs_before = set(glob.glob(str(PROJECT_ROOT / "isolate-*-v8.log")))

    cmd = ["node", "--prof", str(RANKER_CLI), "select", "--date", date_key]
    if seed is not None:
        cmd.extend(["--seed", str(seed)])
    t0 = time.perf_counter()
    cp = sh(cmd, PROJECT_ROOT)
    wall = time.perf_counter() - t0

    # node --prof writes isolate-0x...-v8.log in cwd; pick the newest one.
    v8_logs_after = set(glob.glob(str(PROJECT_ROOT / "isolate-*-v8.log")))
    new_logs = v8_logs_after - v8_logs_before
    v8_log = max(new_logs, key=os.path.getmtime) if new_logs else None

    pp = None
    if v8_log:
        t1 = time.perf_counter()
        pp = sh(["node", "--prof-process", v8_log], PROJECT_ROOT)
        pp_wall = time.perf_counter() - t1
        js_out.write_text(pp.stdout, encoding="utf-8")
        # clean up the isolate log unless the caller asked to keep profiles
    else:
        pp_wall = None
        js_out.write_text("(no isolate log found; --prof-process could not run)\n"
                          f"stderr:\n{cp.stderr}\n", encoding="utf-8")

    return {
        "js_out": js_out,
        "returncode": cp.returncode,
        "stdout": cp.stdout,
        "stderr": cp.stderr,
        "wall": wall,
        "prof_process_wall": pp_wall,
        "v8_log": v8_log,
        "command": " ".join(cmd),
    }


def js_top(js_out: Path, n: int) -> list[tuple]:
    """Parse the [JavaScript] flat profile from --prof-process output.

    Returns list of (ticks, total_pct, nonlib_pct, name) sorted by ticks desc.
    """
    re = __import__("re")
    text = js_out.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "[JavaScript]:":
            start = i
            break
    rows = []
    if start is not None:
        for line in lines[start + 1:]:
            line = line.rstrip()
            if not line.strip() or line.strip().startswith("["):
                break
            m = re.match(r"^\s*(\d+)\s+([0-9.]+)%\s+([0-9.]+)%\s+(.+)$", line)
            if m:
                ticks = int(m.group(1))
                total = float(m.group(2))
                nonlib = float(m.group(3))
                name = m.group(4).strip()
                rows.append((ticks, total, nonlib, name))
    rows.sort(reverse=True)  # sort by ticks desc
    return [(ticks, round(total, 2), round(nonlib, 2), name)
            for ticks, total, nonlib, name in rows[:n]]


# --------------------------------------------------------------------------- report

def print_report(py: dict | None, js: dict | None, top: int,
                 date_key: str, out: Path) -> None:
    line = "=" * 60
    print(line)
    print("DAILY BRIEF CROSS-LANGUAGE PERFORMANCE PROFILE")
    print(line)
    print(f"date (brief.py date_key): {date_key}")
    print(f"out dir:                  {out}")
    print(f"project root:             {PROJECT_ROOT}")
    print(line)

    # ---------- Python ----------
    print("\n--- PYTHON SIDE (cProfile) -------------------------------------")
    if py is None:
        print("(skipped)")
    else:
        print(f"command: {py['command']}")
        print(f"exit code: {py['returncode']}   wall time: {py['wall']:.3f}s")
        if py["stdout"].strip():
            print("--- brief.py stdout (tail) ---")
            print("\n".join(py["stdout"].splitlines()[-5:]))
        if py["stderr"].strip():
            print("--- brief.py stderr (tail) ---")
            print("\n".join(py["stderr"].splitlines()[-8:]))
        try:
            rows = python_top(py["prof_path"], top)
            print(f"\nTop {len(rows)} Python functions by cumulative time:")
            print("  ncalls   tottime   cumtime  function (file:line)")
            for ncalls, tottime, cumtime, func in rows:
                print(f"  {ncalls:<7} {tottime:<9} {cumtime:<9} {func}")
        except Exception as e:
            print(f"(cProfile read failed: {e})")

    # ---------- JS ----------
    print("\n--- JS SIDE (node --prof + --prof-process) --------------------")
    if js is None:
        print("(skipped)")
    else:
        print(f"command: {js['command']}")
        print(f"exit code: {js['returncode']}   node wall: {js['wall']:.3f}s"
              + (f"   prof-process: {js['prof_process_wall']:.3f}s"
                 if js["prof_process_wall"] is not None else ""))
        try:
            rows = js_top(js["js_out"], top)
            if rows:
                print(f"\nTop {len(rows)} JS functions by V8 self ticks ([JavaScript] flat profile):")
                print("   ticks   total%  nonlib%  function")
                for ticks, total, nonlib, name in rows:
                    print(f"  {ticks:<6} {total:<8} {nonlib:<8} {name}")
            else:
                print("(no parseable [JavaScript] flat-profile lines; see js-profile.txt)")
        except Exception as e:
            print(f"(js parse failed: {e})")
        if js["stderr"].strip():
            print("--- node stderr (tail) ---")
            print("\n".join(js["stderr"].splitlines()[-5:]))

    # ---------- cross-language notes ----------
    print("\n--- CROSS-LANGUAGE NOTES --------------------------------------")
    print("* cProfile reports the Node subprocess as one subprocess.run() call "
          "(wall time above); the JS profile shows what happens inside Node.")
    print("* In production the client skips Python entirely and calls the Node "
          "ranker directly, so the JS profile is the prod-relevant hot path.")
    print(f"* Raw files: {out / 'python.prof'}, {out / 'js-profile.txt'}")
    if py is not None and js is not None:
        print(f"* Combined wall time (python brief + node select): "
              f"{py['wall'] + js['wall']:.3f}s")
    print(line)


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Profile python src/brief.py --dry-run across Python + Node (JS) ranker.")
    ap.add_argument("--date", default=now_date_key(),
                    help="date passed to the ranker select (default: today, matching brief.py date_key)")
    ap.add_argument("--seed", type=int, default=None,
                    help="seed passed to brief.py and the ranker select")
    ap.add_argument("--out-dir", default=None,
                    help="output directory for profiles (default: logs/profile_<timestamp>/)")
    ap.add_argument("--top", type=int, default=20,
                    help="number of top functions to show per side (default: 20)")
    ap.add_argument("--brief-args", nargs="*", default=None,
                    help="extra args appended to brief.py "
                         f"(default: {' '.join(DEFAULT_BRIEF_ARGS)})")
    ap.add_argument("--no-python", action="store_true", help="skip the Python cProfile pass")
    ap.add_argument("--no-js", action="store_true", help="skip the Node --prof pass")
    ap.add_argument("--keep-profiles", action="store_true",
                    help="keep the V8 isolate log (default: removed after processing)")
    return ap


def main() -> int:
    ap = build_arg_parser()
    args = ap.parse_args()

    brief_args = list(args.brief_args) if args.brief_args is not None else list(DEFAULT_BRIEF_ARGS)
    if "--dry-run" not in brief_args:
        brief_args = ["--dry-run", *brief_args]

    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    out = Path(args.out_dir) if args.out_dir else PROJECT_ROOT / "logs" / f"profile_{ts}"
    out.mkdir(parents=True, exist_ok=True)

    py = None
    js = None
    if not args.no_python:
        py = run_python_profile(brief_args, out)
    if not args.no_js:
        seed = args.seed
        # If brief has a seed, mirror it into the ranker select for parity.
        if seed is None and "--seed" in brief_args:
            idx = brief_args.index("--seed")
            if idx + 1 < len(brief_args):
                try:
                    seed = int(brief_args[idx + 1])
                except ValueError:
                    seed = None
        js = run_js_profile(args.date, seed, out)
        if not args.keep_profiles and js and js.get("v8_log"):
            try:
                os.remove(js["v8_log"])
            except OSError:
                pass

    print_report(py, js, args.top, args.date, out)

    # Non-zero exit if either profiled run failed (useful in CI).
    codes = [c for c in (py, js) if c is not None]
    return 0 if all(c["returncode"] == 0 for c in codes) else 1


if __name__ == "__main__":
    sys.exit(main())
