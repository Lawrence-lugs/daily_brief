import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchApiFeedsDetailed, refreshApiFeeds, registerApiFetcher,
} from '../lib/fetch/fetcher.js';

registerApiFetcher('test-health-api', async (fetcher, spec) => {
  await fetcher.throttle?.();
  if (spec.fail) throw new Error('boom');
  return [{ id: 'a' }, { id: 'b' }];
});

const fakeFetcher = () => ({
  throttle: async () => {},
  get: async () => '',
});

test('fetchApiFeedsDetailed keeps per-feed counts, skips, and errors', async () => {
  const src = {
    feeds: {
      api: {
        test: [
          { name: 'Working', kind: 'api', fetcher: 'test-health-api' },
          {
            name: 'Needs key', kind: 'api', fetcher: 'test-health-api',
            api_key_env: 'MISSING_TEST_KEY',
          },
          { name: 'Broken', kind: 'api', fetcher: 'test-health-api', fail: true },
          { name: 'No fetcher', kind: 'api', fetcher: 'test-no-such-fetcher' },
        ],
      },
    },
  };

  const results = await fetchApiFeedsDetailed({ fetch: {} }, src, {
    env: {},
    makeFetcher: fakeFetcher,
  });

  assert.equal(results.length, 4);
  assert.equal(results[0].name, 'Working');
  assert.equal(results[0].ok, true);
  assert.equal(results[0].itemCount, 2);
  assert.equal(results[0].items.length, 2);

  assert.equal(results[1].skipped, true);
  assert.equal(results[1].error, 'missing MISSING_TEST_KEY');
  assert.equal(results[1].envVar, 'MISSING_TEST_KEY');

  assert.equal(results[2].ok, false);
  assert.equal(results[2].skipped, false);
  assert.equal(results[2].error, 'boom');
  assert.equal(results[2].errorName, 'Error');

  assert.equal(results[3].skipped, true);
  assert.match(results[3].error, /no fetcher registered/);
});

test('fetchApiFeedsDetailed tolerates a missing sources object', async () => {
  const results = await fetchApiFeedsDetailed({}, undefined, {
    makeFetcher: fakeFetcher,
  });
  assert.deepEqual(results, []);
});

test('refreshApiFeeds forwards detailed results to onResults', async () => {
  const src = {
    feeds: {
      api: {
        test: [
          { name: 'Working', kind: 'api', fetcher: 'test-health-api' },
          { name: 'Broken', kind: 'api', fetcher: 'test-health-api', fail: true },
        ],
      },
    },
  };
  let seen = null;
  const items = await refreshApiFeeds({ fetch: {} }, src, {
    makeFetcher: fakeFetcher,
    onResults: (results) => { seen = results; },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].itemCount, 2);
  assert.equal(seen[1].ok, false);
  assert.equal(items.length, 2);
});
