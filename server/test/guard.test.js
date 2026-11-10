import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../lib/guard.js';

const req = (headers) => ({ headers });

test('guard: localhost only by default', () => {
  assert.equal(guard(req({ host: '127.0.0.1:4873' }), 4873, false), null);
  assert.equal(guard(req({ host: 'dailydie.example' }), 4873, false), 'bad host');
});

test('guard: allowed public host passes Host check; https origin only for that host', () => {
  const extra = ['dailydie.example'];
  const ok = { host: 'dailydie.example', 'x-brief-client': '1', origin: 'https://dailydie.example' };
  assert.equal(guard(req({ host: 'dailydie.example' }), 4873, false, extra), null);
  assert.equal(guard(req(ok), 4873, true, extra), null);
  assert.equal(guard(req({ ...ok, origin: 'https://evil.example' }), 4873, true, extra), 'bad origin');
  assert.equal(guard(req({ host: 'other.example' }), 4873, false, extra), 'bad host');
});

test('guard: https origin is rejected for localhost', () => {
  const r = { host: '127.0.0.1:4873', 'x-brief-client': '1', origin: 'https://127.0.0.1:4873' };
  assert.equal(guard(req(r), 4873, true), 'bad origin');
});
