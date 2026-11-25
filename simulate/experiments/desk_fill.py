"""Persist a configurable offline desk-filling replay with its inputs and review sheet."""
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from sacred import Experiment
from sacred.observers import SqlObserver

ex = Experiment("desk_fill")
ex.observers.append(SqlObserver("sqlite:///docs/experiments/runs.db"))


@ex.config
def defaults():
    db_path = "daily_brief.db"
    config_path = "user/defaults/config.json"
    sources = None
    samples = None
    spec = None
    judgments = None
    db_hash = ""


@ex.config_hook
def identify_database(config, command_name, logger):
    digest = hashlib.sha256()
    with open(config["db_path"], "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return {"db_hash": digest.hexdigest()}


@ex.main
def replay(db_path, config_path, sources, samples, spec, judgments, db_hash, _run):
    profile = Path(config_path).parent
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    sources = sources or str(profile / "sources.json")
    ranker = config.get("ranker", {})
    if ranker.get("engine") == "lr":
        samples = samples or str(profile / ranker.get("perfect_samples_file", "perfect_samples.json"))
    args = ["node", str(Path(__file__).with_suffix(".js")), "--db", db_path]
    for key, path in [("config", config_path), ("sources", sources), ("samples", samples),
                      ("spec", spec), ("judgments", judgments)]:
        if path:
            _run.add_resource(str(path))
            args.extend(["--" + key, str(path)])
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "desk-fill.json"
        subprocess.run(args + ["--out", str(output)], check=True)
        _run.add_artifact(str(output))
