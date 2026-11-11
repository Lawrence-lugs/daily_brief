// user/datadir.js
// Per-user data directory shared by Electron (dev + packaged), the dev server and
// the CLI. Holds the SQLite DB and the editable config/sources/perfect-samples files.
// Moved here from server/lib/datadir.js as part of the configurability overhaul:
// all config-specific code now lives under `user/`.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EDITABLE_FILES, seedDataDir as seedConfigDefaults } from './config.js';

export { EDITABLE_FILES };

export function defaultDataDir() {
  const home = homedir();
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(base, 'daily-brief');
}

/** Copies the DB and editable files from seedRoot into dataDir, only where missing. Never overwrites.
 * @param {string} dataDir   target per-user data directory
 * @param {string} seedRoot  project root containing user/defaults/
 * @param {string} dbFile    database file name (default 'daily_brief.db')
 */
export function seedDataDir(dataDir, seedRoot, dbFile = 'daily_brief.db') {
  seedConfigDefaults(dataDir, seedRoot);
  // The DB file itself is not a config template; it is created by the server on first use.
  // We no longer seed it from the repo (root copy deleted).
}
