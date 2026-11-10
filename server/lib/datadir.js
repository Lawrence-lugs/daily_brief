// Per-user data directory shared by Electron (dev + packaged), the dev server and
// the CLI. Holds the SQLite DB and the editable config/sources/perfect-samples files.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EDITABLE_FILES = ['config.json', 'sources.json', 'perfect_samples.json'];

export function defaultDataDir() {
  const home = homedir();
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(base, 'daily-brief');
}

/** Copies the DB and editable files from seedRoot into dataDir, only where missing. Never overwrites. */
export function seedDataDir(dataDir, seedRoot, dbFile = 'daily_brief.db') {
  mkdirSync(dataDir, { recursive: true });
  for (const f of [dbFile, ...EDITABLE_FILES]) {
    const dst = join(dataDir, f);
    const src = join(seedRoot, f);
    if (!existsSync(dst) && existsSync(src)) copyFileSync(src, dst);
  }
}
