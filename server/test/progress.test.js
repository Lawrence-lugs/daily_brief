import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Progress } from '../lib/progress.js';

function tmpFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'progress-test-'));
  return path.join(dir, 'progress.json');
}
function existsFile(fp) {
  try { readFileSync(fp); return true; } catch { return false; }
}

test('Progress: constructor writes v1 with seq 1 and default phase', () => {
  const f = tmpFile();
  const p = new Progress(f, 'lr');
  assert.equal(p.data.v, 1);
  assert.equal(p.data.seq, 1);
  assert.equal(p.data.phase, 'fetching');
  assert.equal(p.data.engine, 'lr');
  const o = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(o.v, 1);
  assert.equal(o.seq, 1);
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test('Progress: null path never writes and never throws', () => {
  const p = new Progress(null, null);
  assert.equal(p.path, null);
  assert.doesNotThrow(() => p.phase('editing'));
  assert.doesNotThrow(() => p._flush());
});

test('Progress: phase / setEngine / deskInit / deskRaw / deskWorking / deskEdited all increment seq and rewrite atomically', () => {
  const f = tmpFile();
  const p = new Progress(f, null);
  const seqAfterConstruct = p.data.seq; // 1
  p.phase('selecting');
  assert.equal(p.data.seq, seqAfterConstruct + 1);
  assert.equal(p.data.phase, 'selecting');
  p.setEngine('keyword');
  assert.equal(p.data.engine, 'keyword');
  p.deskInit('primary', 'Primary', 5);
  assert.deepEqual(p.data.desks.primary, { title: 'Primary', n: 5, stage: 'pending', working: false, deck: '', items: [] });
  p.deskRaw('primary', [{ id: 'a', title: 'A', snippet: 's' }]);
  assert.equal(p.data.desks.primary.stage, 'raw');
  assert.equal(p.data.desks.primary.items.length, 1);
  assert.equal(p.data.desks.primary.items[0].snippet, 's');
  p.deskWorking('primary', true);
  assert.equal(p.data.desks.primary.working, true);
  p.phase('editing');
  assert.equal(p.data.phase, 'editing');
  p.deskEdited('primary', [{ id: 'a', headline: 'HA', blurb: 'BA', summarized: true }], 'A deck');
  assert.equal(p.data.desks.primary.stage, 'edited');
  assert.equal(p.data.desks.primary.deck, 'A deck');
  assert.equal(p.data.desks.primary.items[0].summarized, true);

  const o = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(o.v, 1);
  assert.equal(o.phase, 'editing');
  assert.equal(o.engine, 'keyword');
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test('Progress: atomic write uses tmp + rename; no tmp lingers', () => {
  const f = tmpFile();
  const p = new Progress(f, null);
  p.phase('done');
  assert.ok(!existsFile(f + '.tmp'), 'tmp file should be renamed away');
  const o = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(o.phase, 'done');
  rmSync(path.dirname(f), { recursive: true, force: true });
});

test('Progress: slimItem truncates snippet to 320 and only keeps ITEM_FIELDS', () => {
  const f = tmpFile();
  const p = new Progress(f, null);
  const long = 'x'.repeat(500);
  p.deskRaw('primary', [{ id: 'a', title: 'A', snippet: long, extra: 'ignored' }]);
  const item = p.data.desks.primary.items[0];
  assert.equal(item.snippet.length, 320);
  assert.ok(!('extra' in item));
  rmSync(path.dirname(f), { recursive: true, force: true });
});
