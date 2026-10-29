"""Pool provider - loads candidate pool from SQLite database."""
from __future__ import annotations
import sqlite3
import json
import datetime as dt
from pathlib import Path
from typing import List, Dict, Any, Optional

UTC = dt.timezone.utc


def _parse_date(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def _age_days(row: Dict, now: dt.datetime) -> float:
    published = _parse_date(row.get("published"))
    first_seen = _parse_date(row.get("first_seen"))
    d = published or first_seen or now
    return max(0.0, (now - d).total_seconds() / 86400)


class PoolProvider:
    """Loads candidate pool from the daily_brief SQLite database.
    
    The pool is loaded as a list of dicts compatible with both engines:
    - Python keyword engine expects: id, rel, age_days, subtopic, source_type, 
      times_shown, rejected
    - Node LR engine expects: id, p (model score), age_days, days_since_shown, 
      cluster, core, source_type
    """
    
    def __init__(self, db_path: str = "daily_brief.db"):
        self.db_path = Path(db_path)
        if not self.db_path.exists():
            raise FileNotFoundError(f"Database not found: {db_path}")
    
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn
    
    def load(self, date: str, max_age_days: float = 120.0, 
             config: Dict | None = None) -> List[Dict]:
        """Load pool for a specific date.
        
        Args:
            date: Date string in YYYY-MM-DD format
            max_age_days: Maximum age of items to include
            config: Optional config dict (for engine-specific settings)
            
        Returns:
            List of candidate dicts
        """
        conn = self._connect()
        try:
            now = dt.datetime.fromisoformat(date + "T12:00:00.000Z").replace(tzinfo=UTC)
            
            # Load pool items
            pool_items = []
            for row in conn.execute("SELECT * FROM candidate_pool"):
                item = dict(row)
                item["id"] = item.pop("item_id")
                
                # Compute age
                item["age_days"] = _age_days(item, now)
                
                # Filter by max age
                if item["age_days"] > max_age_days:
                    continue
                
                # Parse authors
                if item.get("authors"):
                    try:
                        item["authors"] = json.loads(item["authors"])
                    except (json.JSONDecodeError, TypeError):
                        item["authors"] = []
                else:
                    item["authors"] = []
                
                # Get days_since_shown
                last_shown = item.get("last_shown")
                if last_shown:
                    last_dt = _parse_date(last_shown)
                    if last_dt:
                        days_since = (now - last_dt).total_seconds() / 86400
                        item["days_since_shown"] = max(0.0, days_since)
                    else:
                        item["days_since_shown"] = None
                else:
                    item["days_since_shown"] = None
                
                pool_items.append(item)
            
            # Load last shown dates for all items (for LR engine)
            last_shown_map = {}
            for row in conn.execute("SELECT item_id, last_shown FROM candidate_pool WHERE last_shown IS NOT NULL"):
                last_shown_map[row["item_id"]] = row["last_shown"]
            
            # Add same-day shown/rejected counts (to subtract for fair comparison)
            shown_counter, rejected_counter = self._get_same_day_counts(conn, date)
            
            for item in pool_items:
                item_id = item["id"]
                item["times_shown"] = max(0, item.get("times_shown", 0) - shown_counter.get(item_id, 0))
                item["rejected"] = max(0, item.get("rejected", 0) - rejected_counter.get(item_id, 0))
            
            return pool_items
            
        finally:
            conn.close()
    
    def _get_same_day_counts(self, conn: sqlite3.Connection, date: str) -> tuple[Dict, Dict]:
        """Get shown/rejected counts from briefs of the same date."""
        from collections import Counter
        shown, rejected = Counter(), Counter()
        
        for brief in conn.execute(
            "SELECT brief_id, rejected_ids FROM briefs WHERE date=? AND counted=1", (date,)
        ):
            bid = brief["brief_id"]
            for row in conn.execute("SELECT item_id FROM stories WHERE brief_id=?", (bid,)):
                shown[row["item_id"]] += 1
            for i in json.loads(brief["rejected_ids"] or "[]"):
                rejected[i] += 1
        
        return dict(shown), dict(rejected)
    
    def load_with_lr_features(self, date: str, max_age_days: float = 120.0,
                              config: Dict | None = None) -> List[Dict]:
        """Load pool with LR-specific features (model scores, clusters).
        
        This requires the LR model to be fitted. It calls the Node.js pipeline
        to get candidates with p, cluster, core, etc.
        
        For now, this is a placeholder - the LR engine will load its own data
        via the Node.js CLI.
        """
        # The LR engine loads its own data via Node.js
        # This method exists for API compatibility
        return self.load(date, max_age_days, config)
    
    def synthetic(self, n: int = 1000, seed: int = 42) -> List[Dict]:
        """Generate synthetic pool for testing."""
        import random
        rng = random.Random(seed)
        
        sources = ["researchlike", "newslike", "commentary"]
        subtopics = ["ml", "physics", "bio", "cs", "math", "other"]
        
        pool = []
        for i in range(n):
            pool.append({
                "id": f"synth_{i}",
                "title": f"Synthetic Item {i}",
                "rel": rng.uniform(0.1, 1.0),
                "age_days": rng.uniform(0, 120),
                "subtopic": rng.choice(subtopics),
                "source_type": rng.choice(sources),
                "times_shown": rng.randint(0, 5),
                "rejected": rng.randint(0, 3),
                "authors": [],
            })
        return pool