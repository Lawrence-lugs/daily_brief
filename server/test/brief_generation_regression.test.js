import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Derive file:// URLs from import.meta.url (already a file:// URL, so no
// Windows drive-letter scheme problems).
const TEST_URL = new URL(import.meta.url);
const PROJECT_ROOT = new URL('../../', TEST_URL); // file:///.../daily_brief/
const BRIEF_URL = new URL('server/lib/brief.js', PROJECT_ROOT).href;
const DB_URL = new URL('server/lib/db.js', PROJECT_ROOT).href;
const DATA_URL = new URL('user/datadir.js', PROJECT_ROOT).href;

const PROJECT_ROOT_FS = fileURLToPath(PROJECT_ROOT);
// Isolated copy of the data dir so repeated runs never touch the real appdata DB.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'daily-brief-regress-'));
const DB_PATH = join(DATA_DIR, 'daily_brief.db');
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

// Deterministic, network-free flags that still persist to the temp DB.
//   noFetch  -> reuse the persisted candidate pool (no network)
//   noLlm    -> skip the OpenRouter editor (no network)
//   dryRun: false -> appendBrief() actually runs against the temp daily_brief.db
function briefFlags() {
  return { noFetch: true, noLlm: true, dryRun: false, dataDir: DATA_DIR };
}

// Read aggregate row counts through a fresh, independent connection.
// Treats main() as a black box: asserts only on observable persisted state,
// never on internal transaction wrappers, connection handling, or SQL.
async function countRows() {
  const { connect } = await import(DB_URL);
  const conn = connect(DB_PATH);
  try {
    const briefs = conn.prepare('SELECT COUNT(*) AS n FROM briefs').get().n;
    const stories = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
    return { briefs, stories };
  } finally {
    conn.close();
  }
}

test('brief.main: repeated end-to-end generation persists without state leakage', async () => {
  const { main } = await import(BRIEF_URL);
  const { seedDataDir } = await import(DATA_URL);
  seedDataDir(DATA_DIR, PROJECT_ROOT_FS);

  const runs = 3;
  for (let i = 1; i <= runs; i++) {
    const before = await countRows();

    const code = await main(briefFlags());
    assert.equal(code, 0, `run ${i}: main() should return exit code 0`);

    const after = await countRows();
    assert.ok(
      after.briefs >= before.briefs + 1,
      `run ${i}: expected at least one new brief row (${before.briefs} -> ${after.briefs})`,
    );
    assert.ok(
      after.stories >= before.stories + 1,
      `run ${i}: expected at least one new story row (${before.stories} -> ${after.stories})`,
    );
  }
});
