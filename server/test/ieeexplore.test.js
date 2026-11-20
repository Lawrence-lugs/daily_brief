import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIEEEQueryUrl, fetchIEEEItems, mapIEEEArticle,
} from '../lib/fetch/ieeexplore.js';
import { API_FETCHERS } from '../lib/fetch/fetcher.js';

const spec = {
  name: 'IEEE Xplore — JSSC Early Access',
  publication_number: '4',
  content_type: 'Early Access',
  weight: 1,
  type: 'researchlike',
  default_subtopic: 'ams',
};

const article = (n, overrides = {}) => ({
  article_number: String(n),
  title: 'A measured circuit paper ' + n,
  abstract: 'A 12-bit pipeline ADC achieves 80 dB SNDR.',
  publication_date: '2026-11-10',
  insert_date: '20261111',
  authors: { authors: [{ full_name: 'Ada Lovelace' }, { full_name: 'Alan Turing' }] },
  doi: '10.1109/JSSC.2026.' + n,
  index_terms: { author_terms: ['analog-to-digital converter'], ieee_terms: ['pipeline ADC'] },
  ...overrides,
});

test('buildIEEEQueryUrl uses the publication selector and insertion-date filters', () => {
  const url = new URL(buildIEEEQueryUrl({
    apiKey: 'key with spaces', publicationNumber: '4', contentType: 'Early Access',
    startDate: '20261101', endDate: '20261115', startRecord: 201, maxRecords: 250,
  }));
  assert.equal(url.hostname, 'ieeexploreapi.ieee.org');
  assert.equal(url.searchParams.get('apikey'), 'key with spaces');
  assert.equal(url.searchParams.get('publication_number'), '4');
  assert.equal(url.searchParams.get('content_type'), 'Early Access');
  assert.equal(url.searchParams.get('start_date'), '20261101');
  assert.equal(url.searchParams.get('end_date'), '20261115');
  assert.equal(url.searchParams.get('start_record'), '201');
  assert.equal(url.searchParams.get('max_records'), '200');
  assert.equal(url.searchParams.has('publication_title'), false);
});

test('buildIEEEQueryUrl supports conference publication-title searches', () => {
  const url = new URL(buildIEEEQueryUrl({
    apiKey: 'secret', publicationTitle: 'IEEE International Solid-State Circuits Conference',
    contentType: 'Conferences', startDate: '20261101', endDate: '20261115',
  }));
  assert.equal(url.searchParams.get('publication_title'), 'IEEE International Solid-State Circuits Conference');
  assert.equal(url.searchParams.get('content_type'), 'Conferences');
  assert.equal(url.searchParams.has('publication_number'), false);
});

test('buildIEEEQueryUrl requires exactly one publication selector', () => {
  assert.throws(() => buildIEEEQueryUrl({ apiKey: 'x', startDate: '1', endDate: '2' }), /exactly one/);
  assert.throws(() => buildIEEEQueryUrl({ apiKey: 'x', publicationNumber: '4', publicationTitle: 'JSSC', startDate: '1', endDate: '2' }), /exactly one/);
});

test('mapIEEEArticle maps metadata, nested authors, nested keywords, hint, and publication date', () => {
  const item = mapIEEEArticle(article(123), spec);
  assert.equal(item.url, 'https://doi.org/10.1109/JSSC.2026.123');
  assert.equal(item.title, 'A measured circuit paper 123');
  assert.equal(item.published, '2026-11-10T00:00:00.000Z');
  assert.deepEqual(item.authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(item.hint, 'ams');
  assert.equal(item.source_type, 'researchlike');
  assert.match(item.snippet, /12-bit pipeline ADC/);
  assert.match(item.snippet, /analog-to-digital converter/);
  assert.match(item.snippet, /pipeline ADC/);
});

test('mapIEEEArticle falls back to insert_date when publication date has month-only precision', () => {
  const item = mapIEEEArticle(article(124, { publication_date: '2026-11' }), spec);
  assert.equal(item.published, '2026-11-11T00:00:00.000Z');
});

test('fetchIEEEItems fetches a rolling insertion-date window and paginates', async () => {
  const urls = [];
  let throttles = 0;
  const fetcher = {
    async throttle() { throttles++; },
    async get(url) {
      urls.push(new URL(url));
      const startRecord = Number(new URL(url).searchParams.get('start_record'));
      if (startRecord === 1) return JSON.stringify({ totalfound: 3, articles: [article(1), article(2)] });
      return JSON.stringify({ totalfound: 3, articles: [article(3)] });
    },
  };
  const items = await fetchIEEEItems(fetcher, { ...spec, max_records: 2 }, {
    apiKey: 'test-key', now: new Date('2026-11-15T14:00:00Z'),
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(x => x.url), [1, 2, 3].map(n => 'https://doi.org/10.1109/JSSC.2026.' + n));
  assert.equal(urls.length, 2);
  assert.equal(throttles, 2);
  for (const url of urls) {
    assert.equal(url.searchParams.get('start_date'), '20261016');
    assert.equal(url.searchParams.get('end_date'), '20261115');
  }
  assert.equal(urls[1].searchParams.get('start_record'), '3');
});

test('fetchIEEEItems reports missing API key without making a request', async () => {
  await assert.rejects(
    fetchIEEEItems({ get() { assert.fail('should not fetch'); } }, spec, { apiKey: '' }),
    /Missing IEEE_XPLORE_API_KEY/,
  );
});

test('fetchIEEEItems redacts API key from HTTP errors', async () => {
  const fetcher = {
    async get() { throw new Error('HTTP 403 for https://example.test/?apikey=secret-token'); },
  };
  await assert.rejects(
    fetchIEEEItems(fetcher, spec, { apiKey: 'secret-token' }),
    error => error.message.includes('HTTP 403') && !error.message.includes('secret-token'),
  );
});

test('fetchIEEEItems rejects malformed API payloads', async () => {
  await assert.rejects(
    fetchIEEEItems({ async get() { return '{not json'; } }, spec, { apiKey: 'test' }),
    /invalid JSON/,
  );
  await assert.rejects(
    fetchIEEEItems({ async get() { return JSON.stringify({ totalfound: 1 }); } }, spec, { apiKey: 'test' }),
    /no articles array/,
  );
});

test('registers the IEEE Xplore API fetcher', () => {
  assert.equal(API_FETCHERS.ieeexplore, fetchIEEEItems);
});
