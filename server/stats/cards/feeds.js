// Feeds card generator: audits every RSS feed in user/defaults/sources.json.
// Imports auditFeeds from simulate/experiments/audit_feeds.mjs (moved there per plan).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditFeeds } from '../../../simulate/experiments/audit_feeds.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** sha256 of the raw bytes of user/defaults/sources.json. */
export async function sourceHash() {
  const raw = await readFile(join(ROOT, 'user', 'defaults', 'sources.json'));
  return createHash('sha256').update(raw).digest('hex');
}

/** Run the feed audit and return { rows, totals }. */
export async function generate() {
  const results = await auditFeeds({ log: false });
  const rows = results.map((r) => ({
    name: r.name,
    url: r.url,
    type: r.type,
    default_subtopic: r.default_subtopic,
    status: r.status,
    ok: r.ok,
    feedValid: r.feedValid,
    itemCount: r.itemCount,
    blocked: r.blocked,
    blockReason: r.blockReason,
    error: r.error,
  }));
  const ok = results.filter((r) => r.ok && r.feedValid).length;
  const blocked = results.filter((r) => r.blocked).length;
  const failed = results.filter((r) => !r.ok && !r.blocked).length;
  return {
    rows,
    totals: { total: results.length, ok, blocked, failed },
  };
}
