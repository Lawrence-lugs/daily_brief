import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDesksConfig } from '../lib/config.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('config loader: DESKS list includes primary, science, misc in declared order', () => {
  const { DESKS, subtopicToDesk, warnings } = loadDesksConfig('.');
  assert.equal(DESKS.length, 3);
  assert.deepEqual(DESKS, [
    { key: 'primary', title: 'Silicon & Architecture Desk' },
    { key: 'science', title: 'Science Desk' },
    { key: 'misc', title: 'Misc.' },
  ]);
  assert.deepEqual(subtopicToDesk, {
    dse: 'primary', accel: 'primary', fab: 'primary',
    gr: 'science', qft: 'science', condmat: 'science', neuro: 'science',
  });
  assert.equal(warnings.length, 0);
});

test('config loader: sources.json has no desks or keywords', () => {
  const src = JSON.parse(readFileSync('sources.json', 'utf8'));
  assert.ok(!('desks' in src), 'sources.json should not contain desks');
  assert.ok(!('keywords' in src), 'sources.json should not contain keywords');
});

test('config loader: config.json has desks and keywords', () => {
  const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
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
