// user/save.js
// Save path for config edits: validate -> backup -> atomic write -> invalidate cache.
import { writeFileSync, renameSync, existsSync, readdirSync, statSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { validate } from './validate.js';
import { loadConfig, loadSchema, loadDefaults, invalidateCache, EDITABLE_FILES } from './config.js';

const MAX_BACKUPS = 20;

/** Save a config file for fileName in dataDir.
 * @param {string} dataDir   per-user data directory
 * @param {string} fileName  one of EDITABLE_FILES
 * @param {object} newData   parsed JSON to write
 * @returns {{ok: boolean, errors?: Array, backup?: string}}
 */
export function saveConfig(dataDir, fileName, newData) {
  if (!EDITABLE_FILES.includes(fileName)) {
    return { ok: false, errors: [{ path: '(root)', message: `unknown config file "${fileName}"` }] };
  }

  const schema = loadSchema(fileName);
  if (schema) {
    const result = validate(schema, newData);
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
    writeFileSync(tmp, JSON.stringify(newData, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    return { ok: false, errors: [{ path: '(root)', message: `write failed: ${e.message}` }] };
  }

  invalidateCache(dataDir, fileName);
  return { ok: true, backup: backupPath };
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
    data: defaults,
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
