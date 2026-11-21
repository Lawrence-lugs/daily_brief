// Unit test for resolvePsFile: it must resolve relative perfect-sample paths
// against the data directory the caller is using, not the process default.
// The statistics cards pass their per-request data dir, which matters when the
// server runs with BRIEF_DATA_DIR (hosted container).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePsFile } from '../../ranker/pipeline.js';

test('resolvePsFile resolves the default name against the supplied data dir', () => {
  const dataDir = resolve(tmpdir(), 'db-ps-file');
  assert.equal(
    resolvePsFile({}, dataDir),
    resolve(dataDir, 'perfect_samples.json'),
  );
});

test('resolvePsFile honours ranker.perfect_samples_file', () => {
  const dataDir = resolve(tmpdir(), 'db-ps-file');
  assert.equal(
    resolvePsFile({ perfect_samples_file: 'custom.json' }, dataDir),
    resolve(dataDir, 'custom.json'),
  );
});

test('resolvePsFile leaves absolute paths untouched', () => {
  const abs = resolve(tmpdir(), 'abs-perfect-samples.json');
  assert.equal(resolvePsFile({ perfect_samples_file: abs }, '/ignored'), abs);
});
