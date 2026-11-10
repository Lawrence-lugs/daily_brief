import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Derive file:// URLs from import.meta.url (already a file:// URL, so no
// Windows drive-letter scheme problems).
const TEST_URL = new URL(import.meta.url);
const PROJECT_ROOT = new URL('../../', TEST_URL); // file:///.../daily_brief/
const BRIEF_URL = new URL('server/lib/brief.js', PROJECT_ROOT).href;
const DATA_URL = new URL('server/lib/datadir.js', PROJECT_ROOT).href;

// Isolated data dir: never write generated briefs into the real appdata DB.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'daily-brief-gen-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

// Wide-coverage end-to-end smoke test of brief.main():
//   noFetch  -> reuse the persisted candidate pool (no network)
//   noLlm    -> skip the OpenRouter editor (no network)
//   persist  -> dryRun defaults to false, so appendBrief() runs
//
// This exercises fetch-free pool load -> keyword selection -> editor ->
// appendBrief (which writes briefs + stories to the temp daily_brief.db).
// It is not tailored to any single bug; it simply asserts generation succeeds.
function persistFlags() {
  return { noFetch: true, noLlm: true, dataDir: DATA_DIR };
}

test('brief.main: end-to-end generation with persist returns 0', async () => {
  const { main } = await import(BRIEF_URL);
  const { seedDataDir } = await import(DATA_URL);
  seedDataDir(DATA_DIR, fileURLToPath(PROJECT_ROOT));

  const code = await main(persistFlags());

  assert.equal(code, 0);
});
