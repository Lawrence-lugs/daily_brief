import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startApiRefreshWorker } from '../lib/api_refresh.js';

test('starts detached CLI worker for enabled API feeds and passes shared data directory', () => {
  let call;
  const child = new EventEmitter();
  child.unref = () => { child.unreferenced = true; };
  const result = startApiRefreshWorker({
    projectRoot: '/app',
    dataDir: '/data/daily-brief',
    specs: [
      { kind: 'api', fetcher: 'semanticscholar' },
      { kind: 'api', fetcher: 'ieeexplore', api_key_env: 'IEEE_XPLORE_API_KEY' },
      { kind: 'rss' },
    ],
    env: { IEEE_XPLORE_API_KEY: 'configured', KEEP: 'yes' },
    execPath: '/runtime/node',
    spawnProcess: (...args) => { call = args; return child; },
  });
  assert.equal(result.count, 2);
  assert.equal(call[0], '/runtime/node');
  assert.deepEqual(call[1], ['/app/scripts/run_brief.js', '--refresh-api-feeds']);
  assert.equal(call[2].cwd, '/app');
  assert.equal(call[2].detached, true);
  assert.equal(call[2].stdio, 'ignore');
  assert.equal(call[2].env.BRIEF_DATA_DIR, '/data/daily-brief');
  assert.equal(call[2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(call[2].env.KEEP, 'yes');
  assert.equal(child.unreferenced, true);
});

test('does not spawn when every API feed requires a missing API key', () => {
  let spawned = false;
  const result = startApiRefreshWorker({
    projectRoot: '/app',
    dataDir: '/data',
    specs: [{ kind: 'api', api_key_env: 'IEEE_XPLORE_API_KEY' }],
    env: {},
    spawnProcess: () => { spawned = true; },
  });
  assert.equal(result, null);
  assert.equal(spawned, false);
});

test('reports child spawn errors through the supplied callback', () => {
  let handler;
  const child = {
    once(event, fn) { if (event === 'error') handler = fn; },
    unref() {},
  };
  let reported;
  startApiRefreshWorker({
    projectRoot: '/app',
    dataDir: '/data',
    specs: [{ kind: 'api' }],
    env: {},
    spawnProcess: () => child,
    onError: e => { reported = e; },
  });
  const error = new Error('spawn failed');
  handler(error);
  assert.equal(reported, error);
});
