// user/save.js
// Save path for config edits: validate -> backup -> atomic write -> invalidate cache.
import { writeFileSync, renameSync, existsSync, readdirSync, statSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { validate } from './validate.js';
import { loadConfig, loadSchema, loadDefaults, invalidateCache, EDITABLE_FILES } from './config.js';

const MAX_BACKUPS = 20;

/** Stamp machine-managed ids onto perfect samples.
 *
 * `id` is not user-authored: ranker embeddings are stored as `ps:<id>`, the fit
 * cache hashes it, and fitted cluster medoids are reported by it, so it must be
 * stable across saves (an ordinal/index would re-key everything on every
 * reorder). The settings form renders it read-only, which leaves items added
 * through the form without one; give those the lowest free positive number and
 * keep `id` first in the serialized object.
 *
 * @param {Array<object>} samples
 * @returns {Array<object>} the same array, with ids filled in
 */
export function assignPerfectSampleIds(samples) {
  if (!Array.isArray(samples)) return samples;

  const used = new Set();
  for (const row of samples) {
    if (row && typeof row === 'object' && typeof row.id === 'string' && row.id !== '') used.add(row.id);
  }

  let next = 1;
  for (let i = 0; i < samples.length; i++) {
    const row = samples[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.id === 'string' && row.id !== '') continue;
    // Anything else present (a number, null, ...) is left alone so schema
    // validation can reject it instead of silently re-keying the item.
    if (row.id !== undefined && row.id !== '') continue;
    while (used.has(String(next))) next += 1;
    const id = String(next);
    used.add(id);
    next += 1;
    const rest = { ...row };
    delete rest.id;
    samples[i] = { id, ...rest };
  }
  return samples;
}

/** Save a config file for fileName in dataDir.
 * @param {string} dataDir   per-user data directory
 * @param {string} fileName  one of EDITABLE_FILES
 * @param {object} newData   parsed JSON to write
 * @returns {{ok: boolean, errors?: Array, backup?: string, data?: object}}
 */
export function saveConfig(dataDir, fileName, newData) {
  if (!EDITABLE_FILES.includes(fileName)) {
    return { ok: false, errors: [{ path: '(root)', message: `unknown config file "${fileName}"` }] };
  }

  const normalized = fileName === 'perfect_samples.json' ? assignPerfectSampleIds(newData) : newData;

  const schema = loadSchema(fileName);
  if (schema) {
    const result = validate(schema, normalized);
    if (!result.valid) {
      return { ok: false, errors: result.errors };
    }
  }

  const file = resolve(dataDir, fileName);

  // Backup the current file if it exists.
  let backupPath = null;
  if (existsSync(file)) {
    const backupsDir = join(dirname(file), 'backups');
    try { mkdirSyncRecursive(backupsDir); } catch {}
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(backupsDir, `${fileName}.${ts}.json`);
    copyFileSync(file, backupPath);
    pruneBackups(backupsDir, fileName);
  }

  // Atomic write: write to temp file, then rename.
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    return { ok: false, errors: [{ path: '(root)', message: `write failed: ${e.message}` }] };
  }

  invalidateCache(dataDir, fileName);
  return { ok: true, backup: backupPath, data: normalized };
}

/** Restore fileName from the shipped user/defaults template.
 * Uses the normal save path so the current file is validated, backed up and
 * replaced atomically; the old contents remain available under backups/.
 * @param {string} dataDir   per-user data directory
 * @param {string} fileName  one of EDITABLE_FILES
 * @returns {{ok: boolean, errors?: Array, backup?: string|null, data?: object, path?: string, noDefaults?: boolean}}
 */
export function resetConfig(dataDir, fileName) {
  if (!EDITABLE_FILES.includes(fileName)) {
    return { ok: false, errors: [{ path: '(root)', message: `unknown config file "${fileName}"` }] };
  }

  const defaults = loadDefaults(fileName);
  if (defaults === null) {
    return {
      ok: false,
      noDefaults: true,
      errors: [{ path: '(root)', message: `defaults for "${fileName}" not found` }],
    };
  }

  const result = saveConfig(dataDir, fileName, defaults);
  if (!result.ok) return result;

  return {
    ok: true,
    backup: result.backup ?? null,
    data: result.data ?? defaults,
    path: resolve(dataDir, fileName),
  };
}

function mkdirSyncRecursive(dir) {
  mkdirSync(dir, { recursive: true });
}

function pruneBackups(backupsDir, fileName) {
  const prefix = `${fileName}.`;
  const files = readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => ({ name: f, path: join(backupsDir, f), mtime: statSync(join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = MAX_BACKUPS; i < files.length; i++) {
    try { unlinkSync(files[i].path); } catch {}
  }
}
