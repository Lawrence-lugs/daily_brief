import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAlexQueryUrl, fetchOpenAlexItems, mapOpenAlexWork, reconstructAbstract,
} from '../lib/fetch/openalex.js';
import { API_FETCHERS } from '../lib/fetch/fetcher.js';

const spec = {
  name: 'OpenAlex — IEEE JSSC',
  source_id: 'S83637746',
  weight: 1,
  type: 'researchlike',
  default_subtopic: 'ams',
};

const work = (n, overrides = {}) => ({
  id: 'https://openalex.org/W' + n,
  doi: 'https://doi.org/10.1109/JSSC.2026.' + n,
  title: 'A measured circuit paper ' + n,
  publication_date: '2026-11-10',
  created_date: '2026-11-12T00:00:00',
  primary_location: {
    landing_page_url: 'https://ieeexplore.ieee.org/document/' + n,
    source: { id: 'https://openalex.org/S83637746', display_name: 'IEEE Journal of Solid-State Circuits' },
  },
  abstract_inverted_index: {
    'A': [0], '12-bit': [1], 'pipeline': [2], 'ADC': [3], 'achieves': [4], '80': [5], 'dB': [6], 'SNDR.': [7],
  },
  authorships: [
    { author: { display_name: 'Ada Lovelace' } },
    { author: { display_name: 'Alan Turing' } },
  ],
  primary_topic: { display_name: 'Radio Frequency Integrated Circuit Design' },
  topics: [{ display_name: 'Analog and Mixed-Signal Circuit Design' }],
  ...overrides,
});

test('reconstructAbstract restores word order from OpenAlex inverted index', () => {
  assert.equal(
    reconstructAbstract({ 'ADC': [3], 'A': [0], 'pipeline': [2], '12-bit': [1], 'SNDR': [4] }),
    'A 12-bit pipeline ADC SNDR',
  );
  assert.equal(reconstructAbstract(null), '');
});

test('buildOpenAlexQueryUrl uses source-scoped publication dates and supports keyless requests', () => {
  const url = new URL(buildOpenAlexQueryUrl({
    sourceId: 'https://openalex.org/S83637746',
    fromDate: '2026-08-17',
    toDate: '2026-11-15',
    perPage: 250,
    page: 2,
  }));
  assert.equal(url.origin, 'https://api.openalex.org');
  assert.equal(url.pathname, '/works');
  assert.equal(url.searchParams.get('filter'),
    'primary_location.source.id:S83637746,from_publication_date:2026-08-17,to_publication_date:2026-11-15');
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
  assert.match(url.searchParams.get('select'), /topics,primary_topic/);
  assert.equal(url.searchParams.get('per_page'), '100');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.has('api_key'), false);
});

test('buildOpenAlexQueryUrl adds an optional key and rejects invalid source IDs', () => {
  const url = new URL(buildOpenAlexQueryUrl({
    sourceId: 'S83637746', fromDate: '2026-08-17', toDate: '2026-11-15', apiKey: 'optional-key',
  }));
  assert.equal(url.searchParams.get('api_key'), 'optional-key');
  assert.throws(() => buildOpenAlexQueryUrl({
    sourceId: 'not-a-source', fromDate: '2026-08-17', toDate: '2026-11-15',
  }), /source_id/);
});

test('mapOpenAlexWork maps DOI, title, abstract, source, authors, hint, and indexing metadata', () => {
  const item = mapOpenAlexWork(work(123), spec);
  assert.equal(item.url, 'https://doi.org/10.1109/JSSC.2026.123');
  assert.equal(item.title, 'A measured circuit paper 123');
  assert.equal(item.published, '2026-11-10T00:00:00.000Z');
  assert.equal(item.source, 'IEEE Journal of Solid-State Circuits');
  assert.deepEqual(item.authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(item.hint, 'ams');
  assert.equal(item.source_type, 'researchlike');
  assert.match(item.snippet, /12-bit pipeline ADC/);
  assert.match(item.snippet, /Analog and Mixed-Signal Circuit Design/);
  assert.match(item.snippet, /Radio Frequency Integrated Circuit Design/);
  assert.equal(item.openalex_id, 'https://openalex.org/W123');
  assert.equal(item.openalex_created_date, '2026-11-12T00:00:00');
  assert.equal(item.venue_source_id, 'S83637746');
});

test('mapOpenAlexWork skips records without a title and falls back to the OpenAlex work URL', () => {
  const item = mapOpenAlexWork(work(124, { doi: null, primary_location: null }), spec);
  assert.equal(item.url, 'https://openalex.org/W124');
  assert.equal(mapOpenAlexWork(work(125, { title: '' }), spec), null);
});

test('fetchOpenAlexItems uses a rolling publication-date window and paginates', async () => {
  const urls = [];
  let throttles = 0;
  const fetcher = {
    async throttle() { throttles++; },
    async get(url) {
      const parsed = new URL(url);
      urls.push(parsed);
      const page = Number(parsed.searchParams.get('page'));
      if (page === 1) return JSON.stringify({ meta: { count: 3 }, results: [work(1), work(2)] });
      return JSON.stringify({ meta: { count: 3 }, results: [work(3)] });
    },
  };
  const items = await fetchOpenAlexItems(fetcher, { ...spec, per_page: 2, max_pages: 3 }, {
    apiKey: '',
    now: new Date('2026-11-15T14:00:00Z'),
  });
  assert.equal(items.length, 3);
  assert.equal(urls.length, 2);
  assert.equal(throttles, 2);
  assert.equal(urls[0].searchParams.get('from_publication_date'), null);
  for (const url of urls) {
    assert.equal(url.searchParams.get('filter'),
      'primary_location.source.id:S83637746,from_publication_date:2026-08-17,to_publication_date:2026-11-15');
    assert.equal(url.searchParams.get('api_key'), null);
  }
  assert.equal(urls[1].searchParams.get('page'), '2');
});

test('fetchOpenAlexItems allows anonymous single-page retrieval', async () => {
  let called = false;
  const items = await fetchOpenAlexItems({
    async get(url) {
      called = true;
      assert.equal(new URL(url).searchParams.has('api_key'), false);
      return JSON.stringify({ meta: { count: 1 }, results: [work(1)] });
    },
  }, spec, { apiKey: '' });
  assert.equal(called, true);
  assert.equal(items.length, 1);
});

test('fetchOpenAlexItems redacts API keys from request failures', async () => {
  await assert.rejects(
    fetchOpenAlexItems({
      async get() { throw new Error('HTTP 429 for https://api.openalex.org/works?api_key=secret-token'); },
    }, spec, { apiKey: 'secret-token' }),
    error => error.message.includes('HTTP 429') && !error.message.includes('secret-token'),
  );
});

test('fetchOpenAlexItems rejects malformed responses', async () => {
  await assert.rejects(
    fetchOpenAlexItems({ async get() { return '{bad json'; } }, spec, { apiKey: '' }),
    /invalid JSON/,
  );
  await assert.rejects(
    fetchOpenAlexItems({ async get() { return JSON.stringify({ meta: { count: 1 } }); } }, spec, { apiKey: '' }),
    /no results array/,
  );
});

test('registers the OpenAlex API fetcher', () => {
  assert.equal(API_FETCHERS.openalex, fetchOpenAlexItems);
});
