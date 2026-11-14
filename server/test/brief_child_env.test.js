import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forkRunBrief } from '../lib/jobs.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'env_brief_child.js');

test('forkRunBrief sets ELECTRON_RUN_AS_NODE so the child runs under the packaged Electron binary', async () => {
  assert.equal(await forkRunBrief(FIXTURE)({}), 0);
});
