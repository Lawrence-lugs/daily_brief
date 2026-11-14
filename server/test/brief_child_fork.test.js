// Integration test: the real forkRunBrief (server/lib/brief_child.js) must run to
// completion with --no-fetch --dry-run and exit 0.
//
// This is the test that catches the packaged-app fork regression: fork() launches
// process.execPath, which in the packaged Electron app is the app binary, not node.
// Without ELECTRON_RUN_AS_NODE=1 the child never answers over IPC and exits 1
// ("brief child exited with code 1"). jobs.js now sets ELECTRON_RUN_AS_NODE=1.
//
// Runs with: node --test server/test/brief_child_fork.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forkRunBrief } from '../lib/jobs.js';
import { defaultDataDir } from '../../user/datadir.js';

const SOURCE_DB = path.join(defaultDataDir(), 'daily_brief.db');

// Flags mirroring `node scripts/run_brief.js --no-fetch --dry-run --no-llm`.
// noFetch skips the network feed refresh; dryRun returns before persisting;
// noLlm avoids any LLM request. Nothing is written to the data dir.
const FLAGS = { noFetch: true, dryRun: true, noLlm: true };

test('real forkRunBrief --no-fetch --dry-run completes with exit 0', async (t) => {
  // A fresh CI machine may not have a seeded daily_brief.db yet; skip gracefully
  // rather than fail on missing fixture data.
  if (!existsSync(SOURCE_DB)) {
    t.skip('no seeded daily_brief.db in default data dir; skipping fork integration test');
    return;
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'daily-brief-fork-test-'));
  try {
    // Copy the existing pool/embeddings DB so the ranker has candidates to select from.
    copyFileSync(SOURCE_DB, path.join(tmp, 'daily_brief.db'));

    const runBrief = forkRunBrief(); // real brief_child.js
    const exitCode = await runBrief({ ...FLAGS, dataDir: tmp });
    assert.equal(exitCode, 0, `brief child exited with code ${exitCode}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
