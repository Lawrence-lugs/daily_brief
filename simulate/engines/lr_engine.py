"""LR Engine implementation - calls Node.js ranker CLI."""
from __future__ import annotations
import subprocess
import json
import tempfile
import os
from pathlib import Path
from typing import List, Dict, Any, Optional
from simulate.core.engine import Engine


class LREngine(Engine):
    """LR-based selection engine (new).
    
    Uses Bayesian logistic regression with:
    - Ward clustering on embeddings (5 core + 3 side clusters)
    - Model score p = probability of like
    - Value function V = p * exp(-lambda * age) * dedupe(days_since_shown)
    - Cluster round-robin for primary desk (guarantees all core clusters)
    - Epsilon-greedy exploration with flattened weights
    """
    
    def __init__(self, 
                 cli_path: str = "ranker/cli.js",
                 db_path: str = "daily_brief.db",
                 config_path: str = "config.json",
                 project_root: str | None = None):
        self.cli_path = Path(cli_path)
        self.db_path = Path(db_path)
        self.config_path = Path(config_path)
        self.project_root = Path(project_root) if project_root else Path.cwd()
        
        # Verify CLI exists
        if not (self.project_root / self.cli_path).exists():
            raise FileNotFoundError(f"LR CLI not found: {self.project_root / self.cli_path}")
        
        # Cache for cluster metadata
        self._cluster_metadata = None
    
    @property
    def name(self) -> str:
        return "lr"
    
    def select(self, pool: List[Dict], config: Dict, seed: int) -> Dict[str, List[Dict]]:
        """Run LR selection via Node.js CLI and merge with pool data.

        Note: The LR engine loads its own data from the database (embeddings,
        model, interests). The `pool` argument is used for metadata merge
        (source_type, title, subtopic, rel, age_days).

        Args:
            pool: Candidate pool from PoolProvider (used for metadata merge)
            config: Configuration overrides (passed via --set)
            seed: Random seed

        Returns:
            Dict with 'primary' and 'science' keys, each a list of selected items
            with fields: id, mode, p, V, cluster, core, source_type, title, etc.
        """
        # Build overrides for Node CLI - only pass sampling and desks config
        # The Node CLI loads its own config.json, we only override sampling params
        overrides = []
        sampling_config = config.get("sampling", {})
        if sampling_config:
            for key, value in sampling_config.items():
                if isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        overrides.append(f"sampling.{key}.{subkey}={json.dumps(subvalue)}")
                else:
                    overrides.append(f"sampling.{key}={json.dumps(value)}")

        # Also pass desks config if present
        desks_config = config.get("desks", {})
        if desks_config:
            for key, value in desks_config.items():
                overrides.append(f"sampling.desks.{key}={json.dumps(value)}")

        # Run the CLI
        cmd = [
            "node", str(self.cli_path),
            "select",
            "--date", config.get("date", "2026-10-29"),
            "--seed", str(seed),
        ]
        if overrides:
            for ov in overrides:
                cmd.extend(["--set", ov])

        result = subprocess.run(
            cmd,
            cwd=self.project_root,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            raise RuntimeError(f"LR engine failed: {result.stderr}")

        # Parse JSON output
        try:
            selection = json.loads(result.stdout.strip())
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Failed to parse LR output: {result.stdout[:500]}") from e

        # The output format is: { "primary": [{id, mode, p, V, cluster, core}], "science": [...] }
        # We need to add desk field to each item
        formatted = {}
        for desk, items in selection.items():
            formatted[desk] = []
            for item in items:
                formatted[desk].append({
                    **item,
                    "desk": desk,
                    # source_type not directly available, will merge from pool below
                })

        # Merge pool data (source_type, title, subtopic, rel, age_days) into LR results
        pool_by_id = {item["id"]: item for item in pool}
        for desk, items in formatted.items():
            for item in items:
                pool_item = pool_by_id.get(item["id"])
                if pool_item:
                    # Add missing fields from pool
                    for key in ["source_type", "title", "subtopic", "rel", "age_days"]:
                        if key not in item and key in pool_item:
                            item[key] = pool_item[key]

        return formatted

    def get_cluster_metadata(self) -> Dict[str, Any]:
        """Fetch cluster metadata from Node.js inspect command.

        Returns:
            Dict with clusters list containing id, medoid, medoidTitle, size, core
        """
        if self._cluster_metadata is not None:
            return self._cluster_metadata
        
        cmd = [
            "node", str(self.cli_path),
            "inspect",
        ]
        
        result = subprocess.run(
            cmd,
            cwd=self.project_root,
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        if result.returncode != 0:
            # Try to parse stderr for actual error
            raise RuntimeError(f"LR inspect failed: {result.stderr}")
        
        # Parse JSON output (may have log lines before JSON)
        try:
            # Find the first line that starts with {
            lines = result.stdout.strip().split('\n')
            json_start = next(i for i, line in enumerate(lines) if line.strip().startswith('{'))
            json_str = '\n'.join(lines[json_start:])
            data = json.loads(json_str)
        except (json.JSONDecodeError, StopIteration) as e:
            raise RuntimeError(f"Failed to parse LR inspect output: {result.stdout[:500]}") from e
        
        self._cluster_metadata = data
        return data

    def get_cluster_summary(self) -> Dict[str, Any]:
        """Get a summary of clusters for reporting."""
        meta = self.get_cluster_metadata()
        clusters = meta.get("clusters", [])
        
        core_clusters = [c for c in clusters if c.get("core", False)]
        side_clusters = [c for c in clusters if not c.get("core", False)]
        
        return {
            "total": len(clusters),
            "core_count": len(core_clusters),
            "side_count": len(side_clusters),
            "clusters": [
                {
                    "id": c["id"],
                    "medoid": c["medoid"],
                    "medoid_title": c.get("medoidTitle", c["medoid"]),
                    "size": c.get("size", 0),
                    "core": c.get("core", False),
                }
                for c in sorted(clusters, key=lambda x: x["id"])
            ],
        }

    def get_full_pool_scores(self, config: Dict) -> Dict[str, Any]:
        """Get the full LR candidate pool with p and V scores.
        
        Calls the Node.js CLI 'pool' command which returns all candidates
        with their model scores (p) and value scores (V).
        
        Args:
            config: Configuration (must include 'date')
            
        Returns:
            Dict with 'items' (list of candidates with p, V, etc.) and 'summary'
        """
        cmd = [
            "node", str(self.cli_path),
            "pool",
            "--date", config.get("date", "2026-10-29"),
        ]
        
        # Add overrides if present
        overrides = []
        sampling_config = config.get("sampling", {})
        if sampling_config:
            for key, value in sampling_config.items():
                if isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        overrides.append(f"sampling.{key}.{subkey}={json.dumps(subvalue)}")
                else:
                    overrides.append(f"sampling.{key}={json.dumps(value)}")
        
        desks_config = config.get("desks", {})
        if desks_config:
            for key, value in desks_config.items():
                overrides.append(f"sampling.desks.{key}={json.dumps(value)}")
        
        if overrides:
            for ov in overrides:
                cmd.extend(["--set", ov])
        
        result = subprocess.run(
            cmd,
            cwd=self.project_root,
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"LR pool command failed: {result.stderr}")
        
        try:
            return json.loads(result.stdout.strip())
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Failed to parse LR pool output: {result.stdout[:500]}") from e


class LREngineDirect(Engine):
    """LR Engine using direct Node.js module import (for in-process simulation).
    
    This avoids subprocess overhead by importing the sampler directly.
    Requires Node.js with ES modules support.
    """
    
    def __init__(self, project_root: str | None = None):
        self.project_root = Path(project_root) if project_root else Path.cwd()
        self._sampler = None
        self._prepare_candidates = None
        self._store = None
        self._fitted = None
        self._config = None
    
    def _ensure_loaded(self, config: Dict):
        """Lazy-load Node modules and prepare candidates."""
        if self._sampler is not None:
            return
        
        # This would require a Node.js bridge or running in a Node context
        # For now, fall back to subprocess
        raise NotImplementedError("Direct Node import not yet implemented. Use LREngine (subprocess).")


def run_lr_selection(pool: List[Dict], config: Dict, seed: int, 
                     cli_path: str = "ranker/cli.js",
                     project_root: str | None = None) -> Dict[str, List[Dict]]:
    """Standalone function for LR selection."""
    engine = LREngine(cli_path=cli_path, project_root=project_root)
    return engine.select_with_pool_merge(pool, config, seed)