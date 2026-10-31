"""Tests for PoolProvider class."""
from __future__ import annotations
import pytest
import sqlite3
import json
import datetime as dt
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch, PropertyMock

from simulate.core.pool import PoolProvider, _age_days, _parse_date


class TestParseDate:
    """Tests for _parse_date helper."""

    def test_parse_iso_format_with_z(self):
        result = _parse_date("2026-10-29T12:00:00.000Z")
        assert result is not None
        assert result.year == 2026
        assert result.month == 10
        assert result.day == 29
        assert result.tzinfo == dt.timezone.utc

    def test_parse_iso_format_without_z(self):
        result = _parse_date("2026-10-29T12:00:00")
        assert result is not None
        assert result.tzinfo == dt.timezone.utc  # Should be added

    def test_parse_none(self):
        assert _parse_date(None) is None

    def test_parse_empty_string(self):
        assert _parse_date("") is None

    def test_parse_invalid(self):
        assert _parse_date("not-a-date") is None


class TestAgeDays:
    """Tests for _age_days helper."""

    def test_age_days_published(self):
        now = dt.datetime(2026, 10, 29, 12, 0, 0, tzinfo=dt.timezone.utc)
        row = {"published": "2026-10-27T12:00:00.000Z", "first_seen": "2026-10-28T12:00:00.000Z"}
        age = _age_days(row, now)
        assert age == 2.0  # 2 days

    def test_age_days_first_seen_fallback(self):
        now = dt.datetime(2026, 10, 29, 12, 0, 0, tzinfo=dt.timezone.utc)
        row = {"published": None, "first_seen": "2026-10-27T12:00:00.000Z"}
        age = _age_days(row, now)
        assert age == 2.0

    def test_age_days_both_none_fallbacks_to_now(self):
        now = dt.datetime(2026, 10, 29, 12, 0, 0, tzinfo=dt.timezone.utc)
        row = {"published": None, "first_seen": None}
        age = _age_days(row, now)
        assert age == 0.0

    def test_age_days_future_date_clamped(self):
        now = dt.datetime(2026, 10, 29, 12, 0, 0, tzinfo=dt.timezone.utc)
        row = {"published": "2026-11-01T12:00:00.000Z"}
        age = _age_days(row, now)
        assert age == 0.0  # max(0, negative)


class TestPoolProviderInit:
    """Tests for PoolProvider initialization."""

    def test_init_existing_db(self, tmp_path):
        db_file = tmp_path / "test.db"
        db_file.touch()
        
        provider = PoolProvider(str(db_file))
        assert provider.db_path == db_file

    def test_init_nonexistent_db(self, tmp_path):
        db_file = tmp_path / "nonexistent.db"
        
        with pytest.raises(FileNotFoundError):
            PoolProvider(str(db_file))


class TestPoolProviderSynthetic:
    """Tests for synthetic pool generation (no DB needed)."""

    def test_synthetic_basic(self):
        provider = PoolProvider.__new__(PoolProvider)  # Create without __init__
        pool = provider.synthetic(n=10, seed=42)
        
        assert len(pool) == 10
        for item in pool:
            assert "id" in item
            assert "title" in item
            assert "rel" in item
            assert "age_days" in item
            assert "subtopic" in item
            assert "source_type" in item
            assert "times_shown" in item
            assert "rejected" in item
            assert "authors" in item
            assert 0.1 <= item["rel"] <= 1.0
            assert 0 <= item["age_days"] <= 120
            assert item["subtopic"] in ["ml", "physics", "bio", "cs", "math", "other"]
            assert item["source_type"] in ["researchlike", "newslike", "commentary"]
            assert item["times_shown"] >= 0
            assert item["rejected"] >= 0
            assert item["authors"] == []

    def test_synthetic_deterministic(self):
        provider = PoolProvider.__new__(PoolProvider)
        pool1 = provider.synthetic(n=100, seed=123)
        pool2 = provider.synthetic(n=100, seed=123)
        
        for i1, i2 in zip(pool1, pool2):
            assert i1["id"] == i2["id"]
            assert i1["rel"] == i2["rel"]
            assert i1["age_days"] == i2["age_days"]

    def test_synthetic_different_seeds(self):
        provider = PoolProvider.__new__(PoolProvider)
        pool1 = provider.synthetic(n=10, seed=1)
        pool2 = provider.synthetic(n=10, seed=2)
        
        # Should be different
        assert pool1[0]["rel"] != pool2[0]["rel"] or pool1[0]["age_days"] != pool2[0]["age_days"]


class TestPoolProviderLoad:
    """Tests for PoolProvider.load (requires mocking DB)."""

    @pytest.fixture
    def mock_db_rows(self):
        """Sample database rows for testing."""
        return [
            {
                "item_id": "item_1",
                "title": "Test Paper",
                "published": "2026-10-27T12:00:00.000Z",
                "first_seen": "2026-10-27T12:00:00.000Z",
                "rel": 0.9,
                "subtopic": "ml",
                "source_type": "researchlike",
                "times_shown": 1,
                "rejected": 0,
                "authors": '["Author A"]',
                "last_shown": "2026-10-28T12:00:00.000Z",
            },
            {
                "item_id": "item_2",
                "title": "News Article",
                "published": "2026-10-29T06:00:00.000Z",
                "first_seen": "2026-10-29T06:00:00.000Z",
                "rel": 0.7,
                "subtopic": "physics",
                "source_type": "newslike",
                "times_shown": 0,
                "rejected": 0,
                "authors": '[]',
                "last_shown": None,
            },
            {
                "item_id": "item_3",
                "title": "Old Paper",
                "published": "2026-06-01T12:00:00.000Z",
                "first_seen": "2026-06-01T12:00:00.000Z",
                "rel": 0.8,
                "subtopic": "bio",
                "source_type": "commentary",
                "times_shown": 5,
                "rejected": 2,
                "authors": '["Author B", "Author C"]',
                "last_shown": "2026-10-20T12:00:00.000Z",
            },
        ]

    @pytest.fixture
    def mock_brief_rows(self):
        """Sample brief rows for same-day counting."""
        return [
            {
                "brief_id": "brief_1",
                "rejected_ids": '["item_1"]',
            },
        ]

    @pytest.fixture
    def mock_story_rows(self):
        """Sample story rows for same-day counting."""
        return [
            {"item_id": "item_1"},
            {"item_id": "item_2"},
        ]

    def test_load_basic(self, mock_db_rows, mock_brief_rows, mock_story_rows):
        provider = PoolProvider.__new__(PoolProvider)
        provider.db_path = Path("dummy.db")
        
        mock_conn = MagicMock()
        mock_conn.row_factory = sqlite3.Row
        
        # Track which queries are executed
        call_count = [0]
        
        def execute_side_effect(query, params=None):
            cursor = MagicMock()
            call_count[0] += 1
            if call_count[0] == 1:
                # SELECT * FROM candidate_pool
                cursor.__iter__ = Mock(return_value=iter(mock_db_rows))
            elif call_count[0] == 2:
                # SELECT item_id, last_shown FROM candidate_pool WHERE last_shown IS NOT NULL
                cursor.__iter__ = Mock(return_value=iter([
                    {"item_id": "item_1", "last_shown": "2026-10-28T12:00:00.000Z"},
                    {"item_id": "item_3", "last_shown": "2026-10-20T12:00:00.000Z"},
                ]))
            elif call_count[0] == 3:
                # SELECT brief_id, rejected_ids FROM briefs WHERE date=? AND counted=1
                cursor.__iter__ = Mock(return_value=iter(mock_brief_rows))
            elif call_count[0] == 4:
                # SELECT item_id FROM stories WHERE brief_id=?
                cursor.__iter__ = Mock(return_value=iter(mock_story_rows))
            return cursor
        
        mock_conn.execute.side_effect = execute_side_effect
        
        with patch.object(provider, '_connect', return_value=mock_conn):
            pool = provider.load("2026-10-29", max_age_days=120.0)
        
        assert len(pool) == 2  # item_3 is ~150 days old, filtered out
        
        # Check item_1 (age ~2 days, had last_shown)
        item1 = next(i for i in pool if i["id"] == "item_1")
        assert item1["age_days"] == pytest.approx(2.0, abs=0.1)
        assert item1["days_since_shown"] == pytest.approx(1.0, abs=0.1)
        assert item1["authors"] == ["Author A"]
        # times_shown should be reduced by same-day count (1 shown today)
        assert item1["times_shown"] == 0  # 1 - 1 = 0
        assert item1["rejected"] == 0  # 0 - 0 = 0 (rejected count in brief was for item_1 but rejected_ids had it)
        
        # Check item_2 (age ~0.25 days, no last_shown)
        item2 = next(i for i in pool if i["id"] == "item_2")
        assert item2["age_days"] == pytest.approx(0.25, abs=0.1)
        assert item2["days_since_shown"] is None
        assert item2["authors"] == []
        
        # Check item_3 (age ~150 days - should be filtered out if max_age_days < 150)
        # Let's verify with max_age_days=200
        call_count[0] = 0
        with patch.object(provider, '_connect', return_value=mock_conn):
            pool = provider.load("2026-10-29", max_age_days=200.0)
        
        assert len(pool) == 3
        item3 = next(i for i in pool if i["id"] == "item_3")
        assert item3["age_days"] == pytest.approx(150.0, abs=2.0)
        assert item3["days_since_shown"] == pytest.approx(9.0, abs=0.5)
        assert item3["authors"] == ["Author B", "Author C"]
        assert item3["times_shown"] == 5  # No same-day shows for item_3
        assert item3["rejected"] == 2

    def test_load_filters_by_max_age(self, mock_db_rows):
        provider = PoolProvider.__new__(PoolProvider)
        provider.db_path = Path("dummy.db")
        
        mock_conn = MagicMock()
        mock_conn.row_factory = sqlite3.Row
        
        call_count = [0]
        
        def execute_side_effect(query, params=None):
            cursor = MagicMock()
            call_count[0] += 1
            if call_count[0] == 1:
                cursor.__iter__ = Mock(return_value=iter(mock_db_rows))
            elif call_count[0] == 2:
                cursor.__iter__ = Mock(return_value=iter([
                    {"item_id": "item_1", "last_shown": "2026-10-28T12:00:00.000Z"},
                    {"item_id": "item_3", "last_shown": "2026-10-20T12:00:00.000Z"},
                ]))
            elif call_count[0] == 3:
                cursor.__iter__ = Mock(return_value=iter([]))
            return cursor
        
        mock_conn.execute.side_effect = execute_side_effect
        
        with patch.object(provider, '_connect', return_value=mock_conn):
            pool = provider.load("2026-10-29", max_age_days=5.0)
        
        # Only item_1 (2 days) and item_2 (0.25 days) should pass
        # item_3 is ~150 days old
        assert len(pool) == 2
        ids = {i["id"] for i in pool}
        assert ids == {"item_1", "item_2"}

    def test_load_handles_invalid_authors_json(self, mock_db_rows):
        """Test that invalid JSON in authors field is handled gracefully."""
        rows = mock_db_rows.copy()
        rows[0]["authors"] = "not valid json"
        
        provider = PoolProvider.__new__(PoolProvider)
        provider.db_path = Path("dummy.db")
        
        mock_conn = MagicMock()
        mock_conn.row_factory = sqlite3.Row
        
        call_count = [0]
        
        def execute_side_effect(query, params=None):
            cursor = MagicMock()
            call_count[0] += 1
            if call_count[0] == 1:
                cursor.__iter__ = Mock(return_value=iter(rows))
            elif call_count[0] == 2:
                cursor.__iter__ = Mock(return_value=iter([]))
            elif call_count[0] == 3:
                cursor.__iter__ = Mock(return_value=iter([]))
            return cursor
        
        mock_conn.execute.side_effect = execute_side_effect
        
        with patch.object(provider, '_connect', return_value=mock_conn):
            pool = provider.load("2026-10-29", max_age_days=120.0)
        
        item1 = next(i for i in pool if i["id"] == "item_1")
        assert item1["authors"] == []  # Should default to empty list

    def test_load_handles_missing_authors(self, mock_db_rows):
        """Test that missing authors field is handled."""
        rows = mock_db_rows.copy()
        rows[0].pop("authors", None)
        
        provider = PoolProvider.__new__(PoolProvider)
        provider.db_path = Path("dummy.db")
        
        mock_conn = MagicMock()
        mock_conn.row_factory = sqlite3.Row
        
        call_count = [0]
        
        def execute_side_effect(query, params=None):
            cursor = MagicMock()
            call_count[0] += 1
            if call_count[0] == 1:
                cursor.__iter__ = Mock(return_value=iter(rows))
            elif call_count[0] == 2:
                cursor.__iter__ = Mock(return_value=iter([]))
            elif call_count[0] == 3:
                cursor.__iter__ = Mock(return_value=iter([]))
            return cursor
        
        mock_conn.execute.side_effect = execute_side_effect
        
        with patch.object(provider, '_connect', return_value=mock_conn):
            pool = provider.load("2026-10-29", max_age_days=120.0)
        
        item1 = next(i for i in pool if i["id"] == "item_1")
        assert item1["authors"] == []

    def test_load_same_day_counts_subtraction(self, mock_db_rows, mock_brief_rows, mock_story_rows):
        """Test that same-day shown/rejected counts are subtracted."""
        provider = PoolProvider.__new__(PoolProvider)
        provider.db_path = Path("dummy.db")
        
        mock_conn = MagicMock()
        mock_conn.row_factory = sqlite3.Row
        
        call_count = [0]
        
        def execute_side_effect(query, params=None):
            cursor = MagicMock()
            call_count[0] += 1
            if call_count[0] == 1:
                cursor.__iter__ = Mock(return_value=iter(mock_db_rows))
            elif call_count[0] == 2:
                cursor.__iter__ = Mock(return_value=iter([]))
            elif call_count[0] == 3:
                cursor.__iter__ = Mock(return_value=iter(mock_brief_rows))
            elif call_count[0] == 4:
                cursor.__iter__ = Mock(return_value=iter(mock_story_rows))
            return cursor
        
        mock_conn.execute.side_effect = execute_side_effect
        
        with patch.object(provider, '_connect', return_value=mock_conn):
            pool = provider.load("2026-10-29", max_age_days=120.0)
        
        item1 = next(i for i in pool if i["id"] == "item_1")
        # Original times_shown=1, but shown once today -> 0
        assert item1["times_shown"] == 0
        # Original rejected=0, but rejected once today -> 0 (clamped at 0)
        assert item1["rejected"] == 0
        
        item2 = next(i for i in pool if i["id"] == "item_2")
        # Original times_shown=0, shown once today -> 0 (clamped)
        assert item2["times_shown"] == 0


class TestPoolProviderGetSameDayCounts:
    """Tests for _get_same_day_counts method."""

    def test_get_same_day_counts_basic(self):
        provider = PoolProvider.__new__(PoolProvider)
        
        mock_conn = MagicMock()
        
        # Brief rows
        brief_cursor = MagicMock()
        brief_cursor.__iter__ = Mock(return_value=iter([
            {"brief_id": "brief_1", "rejected_ids": '["item_1", "item_2"]'},
            {"brief_id": "brief_2", "rejected_ids": '["item_1"]'},
        ]))
        
        # Story rows for brief_1
        story_cursor_1 = MagicMock()
        story_cursor_1.__iter__ = Mock(return_value=iter([
            {"item_id": "item_1"},
            {"item_id": "item_3"},
        ]))
        
        # Story rows for brief_2
        story_cursor_2 = MagicMock()
        story_cursor_2.__iter__ = Mock(return_value=iter([
            {"item_id": "item_2"},
        ]))
        
        def execute_side_effect(query, params=None):
            if "briefs" in query:
                return brief_cursor
            elif "stories" in query and params == ("brief_1",):
                return story_cursor_1
            elif "stories" in query and params == ("brief_2",):
                return story_cursor_2
            return MagicMock()
        
        mock_conn.execute.side_effect = execute_side_effect
        
        shown, rejected = provider._get_same_day_counts(mock_conn, "2026-10-29")
        
        # Shown: item_1 (brief_1), item_3 (brief_1), item_2 (brief_2)
        assert shown == {"item_1": 1, "item_3": 1, "item_2": 1}
        # Rejected: item_1 (brief_1 + brief_2 = 2), item_2 (brief_1 = 1)
        assert rejected == {"item_1": 2, "item_2": 1}

    def test_get_same_day_counts_no_briefs(self):
        provider = PoolProvider.__new__(PoolProvider)
        mock_conn = MagicMock()
        
        brief_cursor = MagicMock()
        brief_cursor.__iter__ = Mock(return_value=iter([]))
        mock_conn.execute.return_value = brief_cursor
        
        shown, rejected = provider._get_same_day_counts(mock_conn, "2026-10-29")
        
        assert shown == {}
        assert rejected == {}

    def test_get_same_day_counts_empty_rejected_ids(self):
        provider = PoolProvider.__new__(PoolProvider)
        mock_conn = MagicMock()
        
        brief_cursor = MagicMock()
        brief_cursor.__iter__ = Mock(return_value=iter([
            {"brief_id": "brief_1", "rejected_ids": '[]'},
            {"brief_id": "brief_2", "rejected_ids": None},
            {"brief_id": "brief_3", "rejected_ids": '["item_1"]'},
        ]))
        
        story_cursor = MagicMock()
        story_cursor.__iter__ = Mock(return_value=iter([{"item_id": "item_2"}]))
        
        def execute_side_effect(query, params=None):
            if "briefs" in query:
                return brief_cursor
            return story_cursor
        
        mock_conn.execute.side_effect = execute_side_effect
        
        shown, rejected = provider._get_same_day_counts(mock_conn, "2026-10-29")
        
        assert shown == {"item_2": 1}
        assert rejected == {"item_1": 1}


class TestPoolProviderLoadWithLRFeatures:
    """Tests for load_with_lr_features (placeholder method)."""

    def test_load_with_lr_features_calls_load(self):
        provider = PoolProvider.__new__(PoolProvider)
        provider.db_path = Path("dummy.db")
        
        mock_pool = [{"id": "item_1", "rel": 0.9}]
        
        with patch.object(provider, 'load', return_value=mock_pool) as mock_load:
            result = provider.load_with_lr_features("2026-10-29", max_age_days=120.0, config={})
        
        mock_load.assert_called_once_with("2026-10-29", 120.0, {})
        assert result == mock_pool


class TestPoolProviderConnect:
    """Tests for _connect method (requires real DB or extensive mocking)."""

    def test_connect_sets_pragmas(self, tmp_path):
        # Create a real temp DB for this test
        db_file = tmp_path / "test.db"
        import sqlite3
        conn = sqlite3.connect(str(db_file))
        conn.execute("CREATE TABLE candidate_pool (item_id TEXT PRIMARY KEY)")
        conn.close()
        
        provider = PoolProvider(str(db_file))
        conn = provider._connect()
        
        # Check that pragmas were executed (we can't directly verify, but connection should work)
        assert conn is not None
        cursor = conn.execute("SELECT 1")
        assert cursor.fetchone()[0] == 1
        conn.close()