import sys
sys.path.insert(0, '.')            # run from the repo root
from src import db

c = db.connect('daily_brief.db')   # applies schema.sql (idempotent) + one-time backfill
# raises sqlite3.DatabaseError if the index is out of sync with the stories table
c.execute("INSERT INTO stories_fts(stories_fts, rank) VALUES('integrity-check', 1)")
hits = c.execute("SELECT count(*) FROM stories_fts WHERE stories_fts MATCH 'accelerator'").fetchone()[0]
print('index OK;', hits, "hit(s) for 'accelerator'")