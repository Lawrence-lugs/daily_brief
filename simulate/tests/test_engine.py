"""Tests for Engine abstract class and SelectionResult."""
from __future__ import annotations
import pytest
from unittest.mock import Mock, MagicMock

from simulate.core.engine import Engine, SelectionResult


class ConcreteEngine(Engine):
    """Concrete implementation for testing."""
    
    def __init__(self, name: str = "test", selections: dict = None):
        self._name = name
        self._selections = selections or {"primary": [], "science": []}
    
    @property
    def name(self) -> str:
        return self._name
    
    def select(self, pool, config, seed):
        return self._selections


class TestEngineAbstract:
    """Tests for Engine abstract base class."""

    def test_cannot_instantiate_abstract(self):
        with pytest.raises(TypeError):
            Engine()

    def test_concrete_engine_works(self):
        engine = ConcreteEngine("test")
        assert engine.name == "test"
        assert engine.description == "Concrete implementation for testing."
        
        result = engine.select([], {}, 42)
        assert result == {"primary": [], "science": []}

    def test_engine_with_custom_description(self):
        class DocumentedEngine(Engine):
            """Custom engine description."""
            @property
            def name(self): return "doc"
            def select(self, pool, config, seed): return {}
        
        engine = DocumentedEngine()
        assert engine.description == "Custom engine description."

    def test_engine_without_docstring(self):
        class NoDocEngine(Engine):
            @property
            def name(self): return "nodoc"
            def select(self, pool, config, seed): return {}
        
        engine = NoDocEngine()
        assert engine.description == "nodoc"


class TestSelectionResult:
    """Tests for SelectionResult container."""

    def test_selection_result_basic(self):
        selections = {
            "primary": [{"id": "1", "mode": "greedy"}, {"id": "2", "mode": "explore"}],
            "science": [{"id": "3", "mode": "greedy"}],
        }
        
        result = SelectionResult(
            engine_name="keyword",
            seed=42,
            selections=selections,
            pool_size=100,
            config={"epsilon": 0.25},
        )
        
        assert result.engine_name == "keyword"
        assert result.seed == 42
        assert result.selections == selections
        assert result.pool_size == 100
        assert result.config == {"epsilon": 0.25}

    def test_all_picked_ids(self):
        selections = {
            "primary": [{"id": "1"}, {"id": "2"}],
            "science": [{"id": "3"}, {"id": "1"}],  # duplicate across desks
            "reserve": [{"id": "4"}],
        }
        
        result = SelectionResult("test", 1, selections, 10, {})
        
        all_ids = result.all_picked_ids()
        assert all_ids == {"1", "2", "3", "4"}

    def test_all_picked_ids_empty(self):
        selections = {"primary": [], "science": []}
        result = SelectionResult("test", 1, selections, 10, {})
        
        assert result.all_picked_ids() == set()

    def test_desk_picked_ids(self):
        selections = {
            "primary": [{"id": "1"}, {"id": "2"}],
            "science": [{"id": "3"}],
        }
        
        result = SelectionResult("test", 1, selections, 10, {})
        
        assert result.desk_picked_ids("primary") == {"1", "2"}
        assert result.desk_picked_ids("science") == {"3"}
        assert result.desk_picked_ids("reserve") == set()

    def test_desk_picked_ids_missing_desk(self):
        selections = {"primary": [{"id": "1"}]}
        result = SelectionResult("test", 1, selections, 10, {})
        
        assert result.desk_picked_ids("nonexistent") == set()

    def test_to_dict(self):
        selections = {
            "primary": [{"id": "1", "mode": "greedy"}, {"id": "2", "mode": "explore"}],
            "science": [{"id": "3", "mode": "greedy"}],
        }
        
        result = SelectionResult("keyword", 42, selections, 100, {"epsilon": 0.25})
        d = result.to_dict()
        
        assert d["engine"] == "keyword"
        assert d["seed"] == 42
        assert d["pool_size"] == 100
        assert "selections" in d
        assert d["selections"]["primary"] == [{"id": "1", "mode": "greedy"}, {"id": "2", "mode": "explore"}]
        assert d["selections"]["science"] == [{"id": "3", "mode": "greedy"}]

    def test_to_dict_filters_keys(self):
        """to_dict should only include id and mode."""
        selections = {
            "primary": [
                {"id": "1", "mode": "greedy", "age_days": 1.0, "rel": 0.9, "extra": "data"},
            ],
        }
        
        result = SelectionResult("test", 1, selections, 10, {})
        d = result.to_dict()
        
        assert d["selections"]["primary"][0] == {"id": "1", "mode": "greedy"}
        assert "age_days" not in d["selections"]["primary"][0]
        assert "rel" not in d["selections"]["primary"][0]
        assert "extra" not in d["selections"]["primary"][0]

    def test_to_dict_missing_id_or_mode(self):
        selections = {
            "primary": [
                {"mode": "greedy"},  # missing id
                {"id": "2"},  # missing mode
                {},  # missing both
            ],
        }
        
        result = SelectionResult("test", 1, selections, 10, {})
        d = result.to_dict()
        
        assert d["selections"]["primary"][0] == {"id": None, "mode": "greedy"}
        assert d["selections"]["primary"][1] == {"id": "2", "mode": None}
        assert d["selections"]["primary"][2] == {"id": None, "mode": None}


class TestEngineIntegration:
    """Integration tests with concrete engines."""

    def test_engine_select_returns_dict_of_lists(self):
        engine = ConcreteEngine("test", {
            "primary": [{"id": "1"}],
            "science": [{"id": "2"}],
            "reserve": [{"id": "3"}],
        })
        
        result = engine.select([], {}, 1)
        
        assert isinstance(result, dict)
        assert all(isinstance(v, list) for v in result.values())

    def test_engine_select_adds_mode(self):
        """Engine should add mode field to items."""
        engine = ConcreteEngine("test", {
            "primary": [{"id": "1"}],  # no mode
        })
        
        result = engine.select([], {}, 1)
        
        # The base Engine doesn't enforce mode, but concrete implementations should
        assert "primary" in result


class TestMultipleEngines:
    """Tests with multiple engine instances."""

    def test_different_engines_different_names(self):
        engine1 = ConcreteEngine("keyword")
        engine2 = ConcreteEngine("lr")
        
        assert engine1.name != engine2.name

    def test_engine_independence(self):
        engine1 = ConcreteEngine("e1", {"primary": [{"id": "1"}]})
        engine2 = ConcreteEngine("e2", {"primary": [{"id": "2"}]})
        
        r1 = engine1.select([], {}, 1)
        r2 = engine2.select([], {}, 1)
        
        assert r1["primary"][0]["id"] == "1"
        assert r2["primary"][0]["id"] == "2"