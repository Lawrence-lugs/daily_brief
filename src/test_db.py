"""pytest/unittest for db.py. Run: python -m unittest src/test_db.py  (from project root)"""
import datetime as dt, json, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import db

NOW = dt.datetime(2026, 10, 26, 12, 0, tzinfo=dt.timezone.utc)

def item(i, **kw):
    return {"id": i, "url": f"https://x/{i}", "title": f"t{i}", "snippet": "s", "published": NOW.isoformat(),
            "source": "src", "source_type": "newslike", "subtopic": "sub", "desk": "primary", "rel": 0.5, **kw}

def story(i, **kw):
    return {**item(i), "headline": f"h{i}", "blurb": "b", "why_care": "", "tags": ["a"], "significance": 3,
            "summarized": True, "kind": "fresh", "mode": "greedy", "age_days": 1.0, "times_shown": 0, **kw}

def desks(*ids):
    return {"primary": {"title": "P", "deck": "d", "stories": [story(i) for i in ids]},
            "science": {"title": "S", "deck": "d", "stories": []}}

class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.c = db.connect(Path(self.d.name) / "t.db")
    def tearDown(self):
        self.c.close(); self.d.cleanup()
    def shown(self, i):
        return self.c.execute("SELECT times_shown FROM candidate_pool WHERE item_id=?", (i,)).fetchone()[0]
    def append(self, ids, rej=()):
        return db.append_brief(self.c, date_key="2026-10-26", now=NOW, model="m", llm_requests=1,
                               rejected_ids=list(rej), desks_out=desks(*ids), meta={"model": "m"})

    def test_upsert_keeps_counters_and_counts_new(self):
        self.assertEqual(db.upsert_pool(self.c, [item("a"), item("b")], NOW), 2)
        self.append(["a"])
        self.assertEqual(db.upsert_pool(self.c, [item("a", rel=0.9), item("c")], NOW), 1)
        r = self.c.execute("SELECT rel, times_shown FROM candidate_pool WHERE item_id='a'").fetchone()
        self.assertEqual((r["rel"], r["times_shown"]), (0.9, 1))

    def test_same_day_regeneration_is_idempotent_for_counters(self):
        db.upsert_pool(self.c, [item("a"), item("b")], NOW)
        self.append(["a"], rej=["b"]); self.append(["a"], rej=["b"])
        self.assertEqual(self.shown("a"), 1)
        self.assertEqual(self.c.execute("SELECT rejected FROM candidate_pool WHERE item_id='b'").fetchone()[0], 1)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM briefs").fetchone()[0], 2)          # append-only
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM briefs WHERE counted=1").fetchone()[0], 1)

    def test_same_day_counts_for_in_memory_rollback(self):
        db.upsert_pool(self.c, [item("a")], NOW); self.append(["a"])
        shown, _ = db.same_day_counts(self.c, "2026-10-26")
        self.assertEqual(shown["a"], 1)

    def test_feedback_carried_to_regenerated_brief_and_unlike_respected(self):
        db.upsert_pool(self.c, [item("a"), item("b")], NOW)
        b1 = self.append(["a", "b"])
        self.c.execute("UPDATE stories SET liked=1, liked_at='t' WHERE brief_id=? AND item_id='a'", (b1,))
        b2 = self.append(["a"])
        self.assertEqual(self.c.execute("SELECT liked FROM stories WHERE brief_id=?", (b2,)).fetchone()[0], 1)
        self.c.execute("UPDATE stories SET liked=0, liked_at=NULL WHERE brief_id=?", (b2,))   # user un-likes in brief 2
        b3 = self.append(["a"])
        self.assertEqual(self.c.execute("SELECT liked FROM stories WHERE brief_id=?", (b3,)).fetchone()[0], 0)

    def test_training_view_one_row_per_date_item(self):
        db.upsert_pool(self.c, [item("a")], NOW)
        self.append(["a"]); self.append(["a"])
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM training_examples").fetchone()[0], 1)

    def test_failed_append_rolls_back_everything(self):
        db.upsert_pool(self.c, [item("a")], NOW)
        bad = desks("a"); del bad["primary"]["stories"][0]["headline"]
        with self.assertRaises(KeyError):
            db.append_brief(self.c, date_key="2026-10-26", now=NOW, model="m", llm_requests=0,
                            rejected_ids=[], desks_out=bad, meta={})
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM briefs").fetchone()[0], 0)
        self.assertEqual(self.shown("a"), 0)

    def test_prune(self):
        old = item("old", published=(NOW - dt.timedelta(days=100)).isoformat())
        db.upsert_pool(self.c, [old, item("new")], NOW)
        self.assertEqual(db.prune_pool(self.c, NOW, 60), 1)
        self.assertEqual([p["id"] for p in db.load_pool(self.c)], ["new"])

if __name__ == "__main__":
    unittest.main()
