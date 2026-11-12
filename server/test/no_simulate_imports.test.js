// Regression test: runtime code under server/ must never import from simulate/.
// simulate/ is excluded from the container image (container/Dockerfile.dockerignore),
// so any import from it would fail with ERR_MODULE_NOT_FOUND in the hosted container.
// This static check catches the regression at test time, independent of environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');

// Matches `from '...simulate/...'` and `require('...simulate/...')` path references.
const SIMULATE_IMPORT = /from\s+['"](?:\.\/|\.\.\/)*simulate\//;
const SIMULATE_REQUIRE = /require\s*\(\s*['"](?:\.\/|\.\.\/)*simulate\//;

async function walkJs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJs(full));
    } else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test('no server file imports from simulate/', async () => {
  const files = await walkJs(SERVER_DIR);
  const violations = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const rel = file.slice(PROJECT_ROOT.length + 1);
    if (SIMULATE_IMPORT.test(text) || SIMULATE_REQUIRE.test(text)) {
      violations.push(rel);
    }
  }
  assert.equal(violations.length, 0,
    `Found server file(s) importing from simulate/ (simulate/ is dockerignored and absent in the container):\n  ${violations.join('\n  ')}`);
});
