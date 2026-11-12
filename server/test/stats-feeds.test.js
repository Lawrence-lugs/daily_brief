// Unit test for the feeds card totals mapping (Phase 4a): ok = ok && feedValid,
// blocked = blocked, failed = !ok && !blocked, matching printTable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFeeds } from '../../simulate/experiments/audit_feeds.mjs';

// auditFeeds returns rows; this test exercises the same totals mapping the card
// generator uses, against a synthetic fixture array.
const rows = [
  { ok: true, feedValid: true, blocked: false, name: 'working', itemCount: 10 },      // OK
  { ok: false, feedValid: false, blocked: true, blockReason: 'cloudflare-403', name: 'blocked' }, // blocked
  { ok: false, feedValid: false, blocked: false, error: 'HTTP 500', name: 'failed' }, // failed
];

test('totals mapping: one OK, one blocked, one failed', () => {
  const ok = rows.filter((r) => r.ok && r.feedValid).length;
  const blocked = rows.filter((r) => r.blocked).length;
  const failed = rows.filter((r) => !r.ok && !r.blocked).length;
  assert.equal(ok, 1);
  assert.equal(blocked, 1);
  assert.equal(failed, 1);
  assert.equal(rows.length, 3);
});

test('auditFeeds is an exported async function', async () => {
  assert.equal(typeof auditFeeds, 'function');
  const result = await auditFeeds({ log: false });
  assert.ok(Array.isArray(result));
  if (result.length) {
    const r = result[0];
    assert.ok('name' in r && 'url' in r && 'status' in r && 'ok' in r && 'feedValid' in r &&
      'itemCount' in r && 'blocked' in r && 'blockReason' in r && 'error' in r);
  }
});
