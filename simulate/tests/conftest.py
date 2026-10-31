"""Pytest fixtures for simulation framework tests."""
from __future__ import annotations
import pytest
import tempfile
import json
from pathlib import Path
from typing import List, Dict, Any
from unittest.mock import Mock, MagicMock


# =============================================================================
# Common Test Data Fixtures
# =============================================================================

@pytest.fixture
def sample_pool() -> List[Dict[str, Any]]:
    """A small synthetic pool for testing."""
    return [
        {
            "id": "item_1",
            "title": "ML Paper 1",
            "rel": 0.9,
            "age_days": 1.0,
            "subtopic": "ml",
            "source_type": "researchlike",
            "times_shown": 0,
            "rejected": 0,
            "authors": ["Author A"],
        },
        {
            "id": "item_2",
            "title": "ML Paper 2",
            "rel": 0.8,
            "age_days": 3.0,
            "subtopic": "ml",
            "source_type": "researchlike",
            "times_shown": 1,
            "rejected": 0,
            "authors": ["Author B"],
        },
        {
            "id": "item_3",
            "title": "Physics News",
            "rel": 0.7,
            "age_days": 0.5,
            "subtopic": "physics",
            "source_type": "newslike",
            "times_shown": 0,
            "rejected": 0,
            "authors": ["Author C"],
        },
        {
            "id": "item_4",
            "title": "Bio Commentary",
            "rel": 0.6,
            "age_days": 10.0,
            "subtopic": "bio",
            "source_type": "commentary",
            "times_shown": 2,
            "rejected": 1,
            "authors": ["Author D"],
        },
        {
            "id": "item_5",
            "title": "CS Paper",
            "rel": 0.85,
            "age_days": 30.0,
            "subtopic": "cs",
            "source_type": "researchlike",
            "times_shown": 0,
            "rejected": 0,
            "authors": ["Author E"],
        },
        {
            "id": "item_6",
            "title": "Math Article",
            "rel": 0.5,
            "age_days": 60.0,
            "subtopic": "math",
            "source_type": "researchlike",
            "times_shown": 0,
            "rejected": 0,
            "authors": ["Author F"],
        },
    ]


@pytest.fixture
def sample_pool_large() -> List[Dict[str, Any]]:
    """A larger synthetic pool for more comprehensive tests."""
    import random
    rng = random.Random(42)
    
    sources = ["researchlike", "newslike", "commentary"]
    subtopics = ["ml", "physics", "bio", "cs", "math", "other"]
    
    pool = []
    for i in range(100):
        pool.append({
            "id": f"item_{i}",
            "title": f"Item {i}",
            "rel": rng.uniform(0.1, 1.0),
            "age_days": rng.uniform(0, 120),
            "subtopic": rng.choice(subtopics),
            "source_type": rng.choice(sources),
            "times_shown": rng.randint(0, 5),
            "rejected": rng.randint(0, 3),
            "authors": [],
        })
    return pool


@pytest.fixture
def sample_config() -> Dict[str, Any]:
    """Default configuration for tests."""
    return {
        "epsilon": 0.25,
        "a50_days": 7.0,
        "slope": 1.0,
        "age_floor_days": 0.25,
        "explore_gamma": 0.3,
        "shown_decay": 0.05,
        "rejected_decay": 0.3,
        "archive_after_days": 7.0,
        "skip_exhausted_subtopics": True,
        "primary_slots": 5,
        "science_slots": 5,
        "reserve_slots": 25,
        "primary_min_types": {"researchlike": 2, "newslike": 1},
        "science_min_types": {"newslike": 1},
        "primary_subtopics": ["ml", "physics", "cs"],
        "science_subtopics": ["bio", "math", "other"],
    }


@pytest.fixture
def sample_selections() -> Dict[str, List[Dict]]:
    """Sample selections from an engine run."""
    return {
        "primary": [
            {"id": "item_1", "mode": "greedy", "age_days": 1.0, "source_type": "researchlike", "desk": "primary"},
            {"id": "item_2", "mode": "explore", "age_days": 3.0, "source_type": "researchlike", "desk": "primary"},
            {"id": "item_3", "mode": "greedy", "age_days": 0.5, "source_type": "newslike", "desk": "primary"},
            {"id": "item_4", "mode": "greedy", "age_days": 10.0, "source_type": "commentary", "desk": "primary"},
            {"id": "item_5", "mode": "explore", "age_days": 30.0, "source_type": "researchlike", "desk": "primary"},
        ],
        "science": [
            {"id": "item_6", "mode": "greedy", "age_days": 60.0, "source_type": "researchlike", "desk": "science"},
            {"id": "item_7", "mode": "greedy", "age_days": 2.0, "source_type": "newslike", "desk": "science"},
            {"id": "item_8", "mode": "explore", "age_days": 15.0, "source_type": "commentary", "desk": "science"},
            {"id": "item_9", "mode": "greedy", "age_days": 5.0, "source_type": "researchlike", "desk": "science"},
            {"id": "item_10", "mode": "greedy", "age_days": 1.0, "source_type": "researchlike", "desk": "science"},
        ],
        "reserve": [
            {"id": "item_11", "mode": "reserve", "age_days": 20.0, "source_type": "researchlike", "desk": "reserve"},
            {"id": "item_12", "mode": "reserve", "age_days": 40.0, "source_type": "newslike", "desk": "reserve"},
        ],
    }


@pytest.fixture
def sample_run_result() -> Dict[str, Any]:
    """A sample run result for aggregate_runs tests."""
    return {
        "seed": 42,
        "selections": {
            "keyword": {
                "primary": [
                    {"id": "item_1", "mode": "greedy", "age_days": 1.0},
                    {"id": "item_2", "mode": "explore", "age_days": 3.0},
                    {"id": "item_3", "mode": "greedy", "age_days": 0.5},
                ],
                "science": [
                    {"id": "item_4", "mode": "greedy", "age_days": 10.0},
                    {"id": "item_5", "mode": "greedy", "age_days": 2.0},
                ],
            },
            "lr": {
                "primary": [
                    {"id": "item_1", "mode": "greedy", "age_days": 1.0, "cluster": 0},
                    {"id": "item_6", "mode": "explore", "age_days": 3.0, "cluster": 1},
                    {"id": "item_7", "mode": "greedy", "age_days": 0.5, "cluster": 2},
                ],
                "science": [
                    {"id": "item_8", "mode": "greedy", "age_days": 10.0, "cluster": 3},
                    {"id": "item_9", "mode": "greedy", "age_days": 2.0, "cluster": 4},
                ],
            },
        },
    }


@pytest.fixture
def multiple_run_results(sample_run_result) -> List[Dict[str, Any]]:
    """Multiple run results with varying selections."""
    runs = [sample_run_result]
    
    # Run 2 - different selections
    runs.append({
        "seed": 43,
        "selections": {
            "keyword": {
                "primary": [
                    {"id": "item_1", "mode": "greedy", "age_days": 1.0},
                    {"id": "item_2", "mode": "greedy", "age_days": 3.0},
                    {"id": "item_8", "mode": "explore", "age_days": 15.0},
                ],
                "science": [
                    {"id": "item_4", "mode": "greedy", "age_days": 10.0},
                    {"id": "item_10", "mode": "greedy", "age_days": 1.0},
                ],
            },
            "lr": {
                "primary": [
                    {"id": "item_2", "mode": "greedy", "age_days": 3.0, "cluster": 1},
                    {"id": "item_6", "mode": "explore", "age_days": 3.0, "cluster": 1},
                    {"id": "item_11", "mode": "greedy", "age_days": 20.0, "cluster": 2},
                ],
                "science": [
                    {"id": "item_9", "mode": "greedy", "age_days": 2.0, "cluster": 4},
                    {"id": "item_12", "mode": "greedy", "age_days": 40.0, "cluster": 3},
                ],
            },
        },
    })
    
    # Run 3
    runs.append({
        "seed": 44,
        "selections": {
            "keyword": {
                "primary": [
                    {"id": "item_1", "mode": "greedy", "age_days": 1.0},
                    {"id": "item_3", "mode": "greedy", "age_days": 0.5},
                    {"id": "item_5", "mode": "explore", "age_days": 30.0},
                ],
                "science": [
                    {"id": "item_6", "mode": "greedy", "age_days": 60.0},
                    {"id": "item_7", "mode": "greedy", "age_days": 2.0},
                ],
            },
            "lr": {
                "primary": [
                    {"id": "item_1", "mode": "greedy", "age_days": 1.0, "cluster": 0},
                    {"id": "item_3", "mode": "explore", "age_days": 0.5, "cluster": 2},
                    {"id": "item_5", "mode": "greedy", "age_days": 30.0, "cluster": 1},
                ],
                "science": [
                    {"id": "item_4", "mode": "greedy", "age_days": 10.0, "cluster": 3},
                    {"id": "item_10", "mode": "greedy", "age_days": 1.0, "cluster": 4},
                ],
            },
        },
    })
    
    return runs


@pytest.fixture
def temp_output_dir():
    """Temporary output directory for reporter tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def mock_db_connection():
    """Mock SQLite connection for PoolProvider tests."""
    conn = MagicMock()
    cursor = MagicMock()
    conn.execute.return_value = cursor
    conn.__enter__ = Mock(return_value=conn)
    conn.__exit__ = Mock(return_value=False)
    return conn


@pytest.fixture
def sample_raw_config() -> Dict[str, Any]:
    """Sample raw config from config.json."""
    return {
        "date": "2026-10-29",
        "ranker": {
            "sampling": {
                "epsilon": 0.25,
                "halfLifeDays": 7,
                "freshness": {"model": "logistic", "steepness": 1.386},
                "dedupe": {"t0": 7, "scale": 2, "hardWindowDays": 2},
                "explore": {"gamma": 0.5, "floor": 0.01},
                "slots": {"primary": 5, "science": 5, "reserve": 25},
            }
        },
        "selection": {
            "a50_days": 7.0,
            "slope": 1.0,
            "age_floor_days": 0.25,
            "epsilon": 0.25,
            "explore_gamma": 0.3,
            "shown_decay": 0.05,
            "rejected_decay": 0.3,
        }
    }


@pytest.fixture
def flat_config() -> Dict[str, Any]:
    """Flattened config without nested sections."""
    return {
        "date": "2026-10-29",
        "epsilon": 0.25,
        "halfLifeDays": 7,
        "a50_days": 7.0,
        "slope": 1.0,
        "age_floor_days": 0.25,
        "explore_gamma": 0.3,
        "shown_decay": 0.05,
        "rejected_decay": 0.3,
    }


# =============================================================================
# Mock Engine Fixtures
# =============================================================================

class MockEngine:
    """Mock engine for testing runners."""
    
    def __init__(self, name: str = "mock", selections: Dict = None):
        self._name = name
        self._selections = selections or {}
        self.call_count = 0
        self.last_pool = None
        self.last_config = None
        self.last_seed = None
    
    @property
    def name(self) -> str:
        return self._name
    
    def select(self, pool: List[Dict], config: Dict, seed: int) -> Dict[str, List[Dict]]:
        self.call_count += 1
        self.last_pool = pool
        self.last_config = config
        self.last_seed = seed
        return self._selections.copy() if self._selections else {"primary": [], "science": []}


@pytest.fixture
def mock_engine():
    """Create a mock engine with predefined selections."""
    def _create(selections=None):
        return MockEngine("mock", selections)
    return _create


# =============================================================================
# Helper Functions
# =============================================================================

def assert_dict_contains(actual: Dict, expected: Dict):
    """Assert that actual dict contains all key-value pairs from expected."""
    for key, value in expected.items():
        assert key in actual, f"Missing key: {key}"
        if isinstance(value, dict):
            assert_dict_contains(actual[key], value)
        else:
            assert actual[key] == value, f"Mismatch for {key}: {actual[key]} != {value}"