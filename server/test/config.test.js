import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDesksConfig } from '../lib/config.js';
import { resetConfig, saveConfig } from '../../user/save.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('config loader: DESKS list includes primary, science, misc in declared order', () => {
  const { DESKS, subtopicToDesk, warnings } = loadDesksConfig('user/defaults');
  assert.equal(DESKS.length, 3);
  assert.deepEqual(DESKS, [
    { key: 'primary', title: 'Silicon & Architecture Desk', description: 'Semiconductor design and fabrication, analog/mixed-signal IC design, EDA tools, chip architecture, accelerators, and the hardware stack that runs AI workloads.' },
    { key: 'science', title: 'Science Desk', description: 'Physical sciences: general relativity, quantum field theory, condensed matter, neuroscience, and related fundamental research.' },
    { key: 'misc', title: 'Misc.', description: '' },
  ]);
  assert.deepEqual(subtopicToDesk, {
    dse: 'primary', accel: 'primary', fab: 'primary', ams: 'primary',
    gr: 'science', qft: 'science', condmat: 'science', neuro: 'science',
  });
  assert.equal(warnings.length, 0);
});

test('config loader: sources.json has no desks or keywords', () => {
  const src = JSON.parse(readFileSync('user/defaults/sources.json', 'utf8'));
  assert.ok(!('desks' in src), 'sources.json should not contain desks');
  assert.ok(!('keywords' in src), 'sources.json should not contain keywords');
});

test('config loader: config.json has desks and keywords', () => {
  const cfg = JSON.parse(readFileSync('user/defaults/config.json', 'utf8'));
  assert.ok('desks' in cfg, 'config.json should contain desks');
  assert.ok('keywords' in cfg, 'config.json should contain keywords');
  assert.ok('misc' in cfg.desks, 'config.json desks should include misc');
  assert.equal(cfg.desks.misc.title, 'Misc.');
  assert.ok(!cfg.ranker.sampling.desks, 'ranker.sampling.desks should be removed');
  assert.ok(!cfg.ranker.sampling.slots, 'ranker.sampling.slots should be removed');
});

test('config loader: hard error when a desk subtopic has no keyword group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desks-config-test-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: { primary: { title: 'Primary', 'keyword-model-subtopics': ['dse', 'nosuch'] } },
      keywords: { dse: ['x'] },
    }));
    assert.throws(() => loadDesksConfig(dir), /no keyword group "nosuch"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config loader: hard error when a subtopic is assigned to two desks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desks-config-test-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: {
        primary: { title: 'Primary', 'keyword-model-subtopics': ['dse', 'shared'] },
        science: { title: 'Science', 'keyword-model-subtopics': ['gr', 'shared'] },
      },
      keywords: { dse: ['x'], gr: ['y'], shared: ['z'] },
    }));
    assert.throws(() => loadDesksConfig(dir), /assigned to more than one desk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config loader: warning when a keyword group is not assigned to any desk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desks-config-test-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: { primary: { title: 'Primary', 'keyword-model-subtopics': ['dse'] } },
      keywords: { dse: ['x'], orphan: ['y'] },
    }));
    const { warnings } = loadDesksConfig(dir);
    assert.ok(warnings.some((w) => w.includes('orphan') && w.includes('not assigned to any desk')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config loader: warning when a non-misc desk lacks a description', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desks-config-test-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: { primary: { title: 'Primary', 'keyword-model-subtopics': ['dse'] } },
      keywords: { dse: ['x'] },
    }));
    const { warnings } = loadDesksConfig(dir);
    assert.ok(warnings.some((w) => w.includes('primary') && w.includes('no description')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config loader: no warning when misc lacks a description', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desks-config-test-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: { misc: { title: 'Misc.', 'keyword-model-subtopics': [] } },
      keywords: {},
    }));
    const { warnings } = loadDesksConfig(dir);
    assert.ok(!warnings.some((w) => w.includes('misc') && w.includes('no description')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resetConfig: replaces the file with shipped defaults and backs up the old contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-reset-test-'));
  try {
    const current = { paper_name: 'Custom paper', stories_per_desk: 9 };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(current));

    const result = resetConfig(dir, 'config.json');
    assert.equal(result.ok, true);
    assert.equal(result.path, join(dir, 'config.json'));
    assert.ok(result.backup && existsSync(result.backup), 'the previous file should be backed up');

    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    const defaults = JSON.parse(readFileSync('user/defaults/config.json', 'utf8'));
    assert.deepEqual(written, defaults);
    assert.notDeepEqual(written, current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resetConfig: rejects unknown config files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-reset-test-'));
  try {
    const result = resetConfig(dir, 'nope.json');
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /unknown config file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig: stamps ids on perfect samples added through the editor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-id-test-'));
  try {
    writeFileSync(join(dir, 'perfect_samples.json'), JSON.stringify([
      { id: '1', title: 'A', snippet: 'a', type: 'paperlike', core: true, representative: true, desk: 'primary' },
    ]));
    const rows = [
      { title: 'B', snippet: 'b', type: 'paperlike', core: false, representative: false, desk: 'science' },
      { id: '1', title: 'A', snippet: 'a', type: 'paperlike', core: true, representative: true, desk: 'primary' },
      { title: 'C', snippet: 'c', type: 'newslike', core: false, representative: true, desk: 'science' },
    ];
    const result = saveConfig(dir, 'perfect_samples.json', rows);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.data.map((r) => r.id), ['2', '1', '3']);

    const written = JSON.parse(readFileSync(join(dir, 'perfect_samples.json'), 'utf8'));
    assert.deepEqual(written, result.data);
    // id stays the first key so the file remains easy to scan.
    assert.equal(Object.keys(written[0])[0], 'id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig: reuses deleted perfect-sample ids but never duplicates one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-id-test-'));
  try {
    writeFileSync(join(dir, 'perfect_samples.json'), '[]');
    const rows = [
      { id: '2', title: 'B', snippet: 'b', type: 'paperlike', core: false, representative: false, desk: 'science' },
      { title: 'New', snippet: 'n', type: 'paperlike', core: false, representative: false, desk: 'science' },
      { title: 'Newer', snippet: 'm', type: 'paperlike', core: false, representative: false, desk: 'science' },
    ];
    const result = saveConfig(dir, 'perfect_samples.json', rows);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.data.map((r) => r.id), ['2', '1', '3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig: rejects a non-string perfect-sample id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-id-test-'));
  try {
    const result = saveConfig(dir, 'perfect_samples.json', [
      { id: 7, title: 'A', snippet: 'a', type: 'paperlike', core: true, representative: true, desk: 'primary' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /expected type string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig: rejects duplicate perfect-sample ids from the JSON view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-id-test-'));
  try {
    writeFileSync(join(dir, 'perfect_samples.json'), '[]');
    const result = saveConfig(dir, 'perfect_samples.json', [
      { id: '3', title: 'A', snippet: 'a', type: 'paperlike', core: true, representative: true, desk: 'primary' },
      { id: '1', title: 'B', snippet: 'b', type: 'paperlike', core: false, representative: false, desk: 'science' },
      { id: '3', title: 'C', snippet: 'c', type: 'paperlike', core: false, representative: false, desk: 'science' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /duplicate id "3"/);
    // Nothing was written, so the stored file is untouched.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'perfect_samples.json'), 'utf8')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig: accepts unique custom perfect-sample ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-id-test-'));
  try {
    writeFileSync(join(dir, 'perfect_samples.json'), '[]');
    const result = saveConfig(dir, 'perfect_samples.json', [
      { id: 'zigzag', title: 'A', snippet: 'a', type: 'paperlike', core: true, representative: true, desk: 'primary' },
      { id: '7', title: 'B', snippet: 'b', type: 'paperlike', core: false, representative: false, desk: 'science' },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.data.map((r) => r.id), ['zigzag', '7']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
