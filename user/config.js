// user/config.js
// Central config loader for the daily-brief user config files.
// Lives in `user/` (the repo's config-specific code). Provides:
//   - loadConfig(dataDir, fileName)   mtime-cached read from the per-user data dir
//   - seedDataDir(dataDir, seedRoot)   copy defaults into data dir if missing
//   - listEditableFiles()              files managed by the config editor
//   - loadSchema(fileName)             JSON Schema for a config file
//   - invalidateCache(dataDir, fileName)   clear mtime cache entry (called after save)
import { existsSync, readFileSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url)); // .../user
const REPO_ROOT = resolve(MODULE_DIR, '..');
const DEFAULTS_DIR = join(MODULE_DIR, 'defaults');
const SCHEMA_DIR = join(MODULE_DIR, 'schema');

// Editable config files. Kept in sync with user/defaults/ and the schema folder.
export const EDITABLE_FILES = ['config.json', 'sources.json', 'perfect_samples.json'];

// mtime cache: filePath -> { mtimeMs, data }
const configCache = new Map();
const schemaCache = new Map();

export function getDefaultsDir() { return DEFAULTS_DIR; }
export function getSchemaDir() { return SCHEMA_DIR; }
export function getRepoRoot() { return REPO_ROOT; }

export function listEditableFiles() {
  return [...EDITABLE_FILES];
}

/** Copy default config templates into dataDir when missing. Never overwrites. */
export function seedDataDir(dataDir, seedRoot = REPO_ROOT) {
  mkdirSync(dataDir, { recursive: true });
  const defaultsDir = join(seedRoot, 'user', 'defaults');
  for (const f of EDITABLE_FILES) {
    const dst = join(dataDir, f);
    const src = join(defaultsDir, f);
    if (!existsSync(dst) && existsSync(src)) {
      copyFileSync(src, dst);
    }
  }
}

/** Read a config file from dataDir with mtime-based caching. */
export function loadConfig(dataDir, fileName = 'config.json') {
  const file = resolve(dataDir, fileName);
  if (!existsSync(file)) return null;
  const mtimeMs = statSync(file).mtimeMs;
  const cached = configCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  configCache.set(file, { mtimeMs, data });
  return data;
}

/** Clear the mtime cache for a file (call after saving). */
export function invalidateCache(dataDir, fileName = 'config.json') {
  configCache.delete(resolve(dataDir, fileName));
}

/** Load a JSON Schema for a config file, cached. Returns null if missing. */
export function loadSchema(fileName) {
  const cached = schemaCache.get(fileName);
  if (cached) return cached;
  const schemaPath = join(SCHEMA_DIR, fileName.replace(/\.json$/, '.schema.json'));
  if (!existsSync(schemaPath)) return null;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  schemaCache.set(fileName, schema);
  return schema;
}

/** Invalidate the schema cache for a file. */
export function invalidateSchemaCache(fileName) {
  schemaCache.delete(fileName);
}
