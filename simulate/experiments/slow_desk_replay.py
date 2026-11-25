"""Record the offline MicroLab replay, its input identities, and sampled briefs."""
import hashlib
import subprocess
import tempfile
from pathlib import Path

from sacred import Experiment
from sacred.observers import SqlObserver

ex = Experiment("slow_desk_replay")
ex.observers.append(SqlObserver("sqlite:///docs/experiments/runs.db"))


@ex.config
def defaults():
    db_path = "daily_brief.db"
    profile = "user/ulab_settings"
    sources = "user/defaults/sources.json"


@ex.config_hook
def identify_database(config, command_name, logger):
    with open(config["db_path"], "rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return {"db_hash": digest.hexdigest()}


@ex.main
def replay(db_path, profile, sources, db_hash, _run):
    for path in (Path(profile) / "config.json", Path(profile) / "perfect_samples.json", sources):
        _run.add_resource(str(path))
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "replay.json"
        with output.open("wb") as stream:
            subprocess.run(["node", str(Path(__file__).with_suffix(".js")), db_path, profile, sources],
                           stdout=stream, check=True)
        _run.add_artifact(str(output))
