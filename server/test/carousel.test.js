// Carousel (embed) layout: round-robin story order across desks, top-N cutoff, desk layout unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRenderer } from '../lib/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const renderer = makeRenderer({
  templatesDir: join(root, 'server', 'templates'),
  cssFile: join(root, 'tailwind.css'),
  paperName: 'Test Paper',
});

const story = (id) => ({
  story_id: id, item_id: `it${id}`, headline: `Headline ${id}`, blurb: 'blurb', url: 'https://example.com/' + id,
  source: 'src', age_days: 0.5, tags: [], kind: 'fresh', summarized: true, why_care: '', liked: false, saved: false,
  position: id, desk: 'x',
});

const desks = {
  ai: { title: 'AI', deck: '', stories: [story(1), story(2), story(3)] },
  bio: { title: 'Bio', deck: '', stories: [story(4), story(5)] },
};
const brief = { brief_id: 9, date: '2026-11-10', generated_at: '2026-11-10T08:00:00Z', edition: 3, meta: {} };

const render = (topN) => renderer.page({ brief, desks, briefs: [], embed: true, topN });
const orderOf = (html, id) => {
  const m = new RegExp(`<article[^>]*style="order:(\\d+)"[^>]*>(?:(?!</article>)[\\s\\S])*?data-story-id="${id}"`).exec(html);
  return m ? Number(m[1]) : null;
};

test('carousel order interleaves desks round-robin', () => {
  const html = render(5);
  assert.deepEqual([1, 4, 2, 5, 3].map((id) => orderOf(html, id)), [0, 1, 2, 3, 4]);
});

test('stories past topN are flagged data-cr-out; the rest are not', () => {
  const html = render(3);
  const outIds = [...html.matchAll(/data-cr-out[^>]*>(?:(?!<\/article>)[\s\S])*?data-story-id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(outIds.sort(), [3, 5]);
});

test('desk layout still renders every story in both desks', () => {
  const html = render(1);
  for (const id of [1, 2, 3, 4, 5]) assert.ok(html.includes(`data-story-id="${id}"`), `story ${id} missing`);
  assert.ok(html.includes('<section data-swap="desk-ai"'));
  assert.ok(html.includes('<section data-swap="desk-bio"'));
});

test('page links carousel stylesheet and script', () => {
  const html = render(5);
  assert.ok(html.includes('href="static/carousel.css"'));
  assert.ok(html.includes('src="static/carousel.js"'));
  assert.ok(html.includes('id="cr-dots"'));
});
