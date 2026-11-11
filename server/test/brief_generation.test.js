import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Derive file:// URLs from import.meta.url (already a file:// URL, so no
// Windows drive-letter scheme problems).
const TEST_URL = new URL(import.meta.url);
const PROJECT_ROOT = new URL('../../', TEST_URL); // file:///.../daily_brief/
const BRIEF_URL = new URL('server/lib/brief.js', PROJECT_ROOT).href;
const DATA_URL = new URL('user/datadir.js', PROJECT_ROOT).href;
const DB_URL = new URL('server/lib/db.js', PROJECT_ROOT).href;

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

// Blind-spot test: LR engine returns partial desk results (a desk with zero
// candidates is absent from selectBrief's output), the LLM succeeds, and
// split[desk] is undefined for the missing desk.
//
// Before the fix this threw:
//   TypeError: undefined is not iterable (cannot read property Symbol(Symbol.iterator))
// at ` [stories, rejected, deck] = split[desk]; ` in brief.js main().
//
// The existing e2e tests use `noLlm: true`, so `split` is always null and they
// always take the safe `applyEditor` else-branch — they never exercise the
// `split` path. This test covers it by:
//   1. filtering perfect_samples.json to primary-desk only, so ensureFitted
//      builds interests with a single (primary) cluster desk,
//   2. deleting all science items from candidate_pool (belt and suspenders),
//   3. mocking OpenRouter so LLM.chat() succeeds.
//
// Result: selectBrief returns only {'primary': [...]}, so `selected` lacks
// 'science'; `split` lacks 'science'; destructuring split['science'] would
// throw "undefined is not iterable". The fix falls back to applyEditor().
test('brief.main: LR generation succeeds when LR returns partial desks (split[desk] fallback)', async () => {
  const { main } = await import(BRIEF_URL);
  const { seedDataDir } = await import(DATA_URL);
  const { connect } = await import(DB_URL);
  seedDataDir(DATA_DIR, fileURLToPath(PROJECT_ROOT));

  // Constrain perfect samples to primary desk only so interests have a single
  // cluster desk. All candidates then map to desk='primary' and selectBrief
  // returns only {'primary': [...]} — 'science' is absent from `selected`.
  const psPath = join(DATA_DIR, 'perfect_samples.json');
  const ps = JSON.parse(readFileSync(psPath, 'utf8'));
  const primaryOnly = ps.filter((s) => s.desk === 'primary');
  writeFileSync(psPath, JSON.stringify(primaryOnly));

  const conn = connect(join(DATA_DIR, 'daily_brief.db'));
  try {
    conn.prepare('DELETE FROM candidate_pool WHERE desk = ?').run('science');
  } finally {
    conn.close();
  }

  // Mock OpenRouter so LLM.remainingDaily() and LLM.chat() both succeed
  // without any real network access.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v1/key')) {
      return new Response(
        JSON.stringify({ data: { free_model_daily_requests: { remaining: 10 } } }),
      );
    }
    if (u.includes('/chat/completions')) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"decks":{},"items":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  process.env.OPENROUTER_API_KEY = 'test-key';

  try {
    const code = await main({ noFetch: true, noLlm: false, dataDir: DATA_DIR, engine: 'lr' });
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.OPENROUTER_API_KEY;
  }
});
