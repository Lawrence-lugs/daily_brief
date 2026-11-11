import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
db.exec(readFileSync('schema.sql', 'utf8'));

// Insert brief
db.prepare(`INSERT INTO briefs (date, edition, generated_at, model, desks, meta) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('2026-10-28', 1, '2026-10-28T10:00:00.000Z', 'm', '{}', '{}');

// Insert 3 stories
db.prepare(`INSERT INTO stories (brief_id, item_id, desk, position, headline, blurb, url, source, subtopic, source_type, age_days, tags, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(1, 'a', 'primary', 0, 'Headline A', 'Blurb A', 'https://x/a', 'Test', 'sub', 'newslike', 1, '[]', 'fresh');
db.prepare(`INSERT INTO stories (brief_id, item_id, desk, position, headline, blurb, url, source, subtopic, source_type, age_days, tags, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(1, 'b', 'primary', 1, 'Headline B', 'Blurb B', 'https://x/b', 'Test', 'sub', 'newslike', 2, '[]', 'fresh');
db.prepare(`INSERT INTO stories (brief_id, item_id, desk, position, headline, blurb, url, source, subtopic, source_type, age_days, tags, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(1, 'c', 'primary', 2, 'Headline C', 'Blurb C', 'https://x/c', 'Test', 'sub', 'paperlike', 3, '[]', 'fresh');

// Insert likes/saves
db.prepare(`INSERT INTO likes (session_id, item_id, liked_at) VALUES (?, ?, ?)`).run('s1', 'a', '2026-10-28T10:00:00.000Z');
db.prepare(`INSERT INTO saves (session_id, item_id, saved_at) VALUES (?, ?, ?)`).run('s2', 'c', '2026-10-28T10:00:00.000Z');

// Check training_examples view
const rows = db.prepare('SELECT * FROM training_examples').all();
console.log('training_examples rows:', rows.length);
rows.forEach(r => console.log(' ', r.item_id, 'liked=', r.liked, 'saved=', r.saved, 'date=', r.date));

// Check what getTrainingRows SQL returns
const trainingRows = db.prepare(`
  SELECT t.item_id, t.source_type, MIN(t.date) AS date,
         MAX(CASE WHEN t.liked=1 OR t.saved=1 THEN 1 ELSE 0 END) AS y
  FROM training_examples t
  WHERE t.date <= '9999-12-31'
  GROUP BY t.item_id ORDER BY date, t.item_id
`).all();
console.log('trainingRows:', trainingRows.length);
trainingRows.forEach(r => console.log(' ', r.item_id, 'y=', r.y));
