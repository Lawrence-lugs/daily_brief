// Thin wrapper around node:sqlite DatabaseSync for ranker operations.
// Reuses the same schema and pragmas as server/lib/queries.js openDb.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBlob, toBlob } from './vec.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCHEMA_FILE = resolve(__dirname, '..', 'schema.sql');

const SQL = {
  missingEmbeddings: `
    SELECT p.item_id AS id, p.title AS title, p.snippet AS body
      FROM candidate_pool p LEFT JOIN embeddings e ON e.item_id=p.item_id WHERE e.item_id IS NULL
    UNION
    SELECT s.item_id, s.headline, s.blurb
      FROM stories s LEFT JOIN embeddings e ON e.item_id=s.item_id
     WHERE e.item_id IS NULL AND NOT EXISTS (SELECT 1 FROM candidate_pool p WHERE p.item_id=s.item_id)
     GROUP BY s.item_id`,
  likedIds: `SELECT DISTINCT item_id FROM likes WHERE liked_at >= ?
              UNION
              SELECT DISTINCT item_id FROM saves WHERE saved_at >= ?`,
  likedWithDates: `SELECT item_id, SUBSTR(MIN(liked_date), 1, 10) AS liked_date FROM (
                      SELECT item_id, liked_at AS liked_date FROM likes WHERE liked_at >= ?
                      UNION ALL
                      SELECT item_id, saved_at AS liked_date FROM saves WHERE saved_at >= ?
                   ) GROUP BY item_id`,
  lastShown: `SELECT s.item_id, MAX(b.generated_at) AS last FROM stories s JOIN briefs b ON b.brief_id=s.brief_id
               WHERE b.date < ? GROUP BY s.item_id`,
  trainingRows: `
    SELECT t.item_id, t.source_type, MIN(t.date) AS date,
           MAX(CASE WHEN t.liked=1 OR t.saved=1 THEN 1 ELSE 0 END) AS y, m.authors
      FROM training_examples t LEFT JOIN item_meta m ON m.item_id=t.item_id
     WHERE t.date <= ?
     GROUP BY t.item_id ORDER BY date, t.item_id`,
  pool: `SELECT p.*, m.authors FROM candidate_pool p LEFT JOIN item_meta m ON m.item_id=p.item_id ORDER BY p.item_id`,
  prune: `DELETE FROM embeddings WHERE item_id NOT LIKE 'ps:%' AND item_id NOT IN
            (SELECT item_id FROM candidate_pool UNION SELECT item_id FROM stories)`,
  pruneOtherModels: `DELETE FROM embeddings WHERE model != ?`,
  embeddingById: `SELECT item_id, model, text_hash, dim, vec FROM embeddings WHERE item_id = ?`,
  embeddingAll: `SELECT item_id, model, text_hash, dim, vec FROM embeddings`,
  upsertEmbedding: `INSERT INTO embeddings (item_id, model, text_hash, dim, vec)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(item_id) DO UPDATE SET model=excluded.model, text_hash=excluded.text_hash, dim=excluded.dim, vec=excluded.vec`,
  insertModelEval: `INSERT INTO model_eval (embedding_tag, cutoff_date, test_frac, n_train, n_test,
                     prior_auc, prior_logloss, keyword_auc, keyword_logloss, fitted_auc, fitted_logloss, results)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  getState: `SELECT value FROM ranker_state WHERE key = ?`,
  setState: `INSERT INTO ranker_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
};

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
    this.db.exec(readFileSync(SCHEMA_FILE, 'utf8'));
    // Migration v3→v4: copy stranded like/save data from stories columns to new likes/saves tables.
    const hasLikedCol = this.db.prepare("SELECT 1 FROM pragma_table_info('stories') WHERE name='liked'").get();
    if (hasLikedCol && !this.db.prepare("SELECT 1 FROM ranker_state WHERE key='migrated_likes_v4'").get()) {
      const likes = this.db.prepare(`
        INSERT OR IGNORE INTO likes (session_id, item_id, liked_at)
        SELECT 'legacy', s.item_id, COALESCE(s.liked_at, b.generated_at)
        FROM stories s JOIN briefs b ON b.brief_id = s.brief_id WHERE s.liked = 1
      `).run().changes;
      const saves = this.db.prepare(`
        INSERT OR IGNORE INTO saves (session_id, item_id, saved_at)
        SELECT 'legacy', s.item_id, COALESCE(s.saved_at, b.generated_at)
        FROM stories s JOIN briefs b ON b.brief_id = s.brief_id WHERE s.saved = 1
      `).run().changes;
      if (likes + saves > 0) console.error('[migrate] copied stranded like/save data from stories to likes/saves tables');
      this.db.prepare("INSERT INTO ranker_state (key, value, updated_at) VALUES ('migrated_likes_v4', '1', datetime('now'))").run();
    }
    this.stmts = {
      missingEmbeddings: this.db.prepare(SQL.missingEmbeddings),
      likedIds: this.db.prepare(SQL.likedIds),
      likedWithDates: this.db.prepare(SQL.likedWithDates),
      lastShown: this.db.prepare(SQL.lastShown),
      trainingRows: this.db.prepare(SQL.trainingRows),
      pool: this.db.prepare(SQL.pool),
      prune: this.db.prepare(SQL.prune),
      pruneOtherModels: this.db.prepare(SQL.pruneOtherModels),
      embeddingById: this.db.prepare(SQL.embeddingById),
      embeddingAll: this.db.prepare(SQL.embeddingAll),
      upsertEmbedding: this.db.prepare(SQL.upsertEmbedding),
      insertModelEval: this.db.prepare(SQL.insertModelEval),
      getState: this.db.prepare(SQL.getState),
      setState: this.db.prepare(SQL.setState),
    };
  }

  close() {
    this.db.close();
  }

  // Get items missing embeddings (pool + stories fallback)
  getMissingEmbeddings() {
    return this.stmts.missingEmbeddings.all().map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
    }));
  }

  // Get liked item IDs within maxLikedDays
  getLikedIds(cutoffDate) {
    return this.stmts.likedIds.all(cutoffDate, cutoffDate).map((r) => r.item_id);
  }

  // Liked OR saved items within cutoff, with the date they were first liked (YYYY-MM-DD)
  getLikedWithDates(cutoffDate) {
    return this.stmts.likedWithDates.all(cutoffDate, cutoffDate).map((r) => ({ item_id: r.item_id, liked_date: r.liked_date }));
  }

  // Get last shown date for each item (before dateKey)
  getLastShown(dateKey) {
    return this.stmts.lastShown.all(dateKey).map((r) => ({
      item_id: r.item_id,
      last: r.last,
    }));
  }

  // Get training rows (one per item, with first exposure date and ever-liked label)
  getTrainingRows(cutoffDate) {
    return this.stmts.trainingRows.all(cutoffDate ?? '9999-12-31').map((r) => ({
      item_id: r.item_id,
      source_type: r.source_type,
      date: r.date,
      y: r.y,
      authors: JSON.parse(r.authors ?? '[]'),
    }));
  }

  // Get pool items with authors
  getPool() {
    return this.stmts.pool.all().map((r) => ({
      ...r,
      id: r.item_id,  // alias for compatibility
      authors: JSON.parse(r.authors ?? '[]'),
    }));
  }

  // Prune embeddings not in pool or stories
  pruneEmbeddings() {
    this.stmts.prune.run();
  }

  // Drop embeddings written by another model/dtype (vectors from different models are not comparable)
  pruneEmbeddingsOtherModels(tag) {
    this.stmts.pruneOtherModels.run(tag);
  }

  // Get embedding by item_id
  getEmbedding(itemId) {
    const row = this.stmts.embeddingById.get(itemId);
    if (!row) return null;
    return {
      item_id: row.item_id,
      model: row.model,
      text_hash: row.text_hash,
      dim: row.dim,
      vec: fromBlob(row.vec),
    };
  }

  // Get all embeddings
  getAllEmbeddings() {
    return this.stmts.embeddingAll.all().map((row) => ({
      item_id: row.item_id,
      model: row.model,
      text_hash: row.text_hash,
      dim: row.dim,
      vec: fromBlob(row.vec),
    }));
  }

  // Upsert embedding
  upsertEmbedding(itemId, model, textHash, dim, vec) {
    this.stmts.upsertEmbedding.run(itemId, model, textHash, dim, toBlob(vec));
  }

  // Log one eval run (embedding model comparison)
  logModelEval({ embeddingTag, cutoffDate, testFrac, nTrain, nTest, results }) {
    const n = (x) => (Number.isFinite(x) ? x : null);
    const get = (model, key) => {
      const m = results && results[model];
      return m != null && typeof m === 'object' ? n(m[key]) : null;
    };
    this.stmts.insertModelEval.run(
      embeddingTag, cutoffDate ?? null, n(testFrac), nTrain ?? null, nTest ?? null,
      get('prior', 'auc'), get('prior', 'logLoss'),
      get('keyword', 'auc'), get('keyword', 'logLoss'),
      get('fitted', 'auc'), get('fitted', 'logLoss'),
      JSON.stringify(results ?? {}),
    );
  }

  // Get state by key
  getState(key) {
    const row = this.stmts.getState.get(key);
    return row ? row.value : null;
  }

  // Set state by key
  setState(key, value) {
    this.stmts.setState.run(key, value);
  }
}

export { SQL };