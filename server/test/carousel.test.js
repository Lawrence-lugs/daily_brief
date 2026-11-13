// Carousel (embed) layout: round-robin story order across desks, top-N cutoff, desk layout unchanged,
// plus client-side dot/autoplay behavior in server/public/carousel.js (jsdom).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
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

test('carousel renders every story (no top-N cutoff)', () => {
  const html = render(3);
  for (const id of [1, 2, 3, 4, 5]) assert.ok(html.includes(`data-story-id="${id}"`), `story ${id} missing`);
  assert.ok(!html.includes('data-cr-out'), 'no story should be flagged cr-out');
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
  assert.ok(html.includes('class="carousel-dots"'));
  assert.ok(!html.includes('class="cr-nav"'));
  assert.ok(!html.includes('class="cr-dot"'));
});

const CAROUSEL_SRC = readFileSync(join(root, 'server', 'public', 'carousel.js'), 'utf8');

// Build a jsdom window containing the carousel track + dots, then eval carousel.js inside it.
// search  : query string (controls ?carousel=1 / ?autoplay=1).
// visible : number of visible story cards (one dot each).
// cr      : whether <html> has the 'cr' class (carousel layout active).
// reduced : whether prefers-reduced-motion matches.
function buildCarousel({ search = '?carousel=1', visible = 4, cr = true, reduced = false } = {}) {
  const cards = Array.from({ length: visible }, (_, i) =>
    `<article class="story-card" data-story-id="${i + 1}">Story ${i + 1}</article>`).join('');
  const html = `<!doctype html><html${cr ? ' class="cr"' : ''}>
  <head></head>
  <body>
    <div data-desks>${cards}</div>
    <nav id="cr-dots" aria-label="Carousel pages"></nav>
  </body></html>`;
  const dom = new JSDOM(html, {
    url: 'http://localhost' + search,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: reduced });
  return { dom, w };
}

function spyTimers(w, track) {
  const intervals = [], clears = [], scrolls = [];
  w.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  w.clearInterval = () => { clears.push(true); };
  track.scrollTo = (opts) => { if (opts.left != null) track.scrollLeft = opts.left; scrolls.push(opts); };
  return { intervals, clears, scrolls };
}

function evalCarousel(w) {
  w.eval(CAROUSEL_SRC);
}

test('carousel dots: one per visible story, aria-labels, new class names', () => {
  const { w } = buildCarousel({ visible: 4 });
  evalCarousel(w);
  const nav = w.document.getElementById('cr-dots');
  const dots = [...nav.querySelectorAll('.carousel-dot')];
  assert.equal(dots.length, 4);
  assert.ok(dots.every((d) => d instanceof w.HTMLButtonElement && d.type === 'button'));
  assert.deepEqual(dots.map((d, i) => d.getAttribute('aria-label')),
    ['Story 1', 'Story 2', 'Story 3', 'Story 4']);
  assert.ok(!nav.classList.contains('cr-nav'));
  assert.ok(!dots.some((d) => d.classList.contains('cr-dot')));
});

test('carousel marks active dot by scroll position', () => {
  const { w } = buildCarousel({ visible: 4 });
  evalCarousel(w);
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  track.scrollLeft = 190;
  const nav = w.document.getElementById('cr-dots');
  const dots = [...nav.querySelectorAll('.carousel-dot')];
  track.dispatchEvent(new w.Event('scroll'));
  assert.equal(dots[2].getAttribute('aria-current'), 'true');
  assert.ok(dots[2].classList.contains('active'));
  assert.ok(dots.every((d, j) => d.getAttribute('aria-current') === (j === 2 ? 'true' : 'false')));
});

test('carousel fades dots outside the active window when there are too many', () => {
  const { w } = buildCarousel({ visible: 10 });
  evalCarousel(w);
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const nav = w.document.getElementById('cr-dots');
  const dots = [...nav.querySelectorAll('.carousel-dot')];
  assert.equal(dots.length, 10, 'one dot per story');
  // one dot per story and none are removed from the DOM
  assert.ok(dots.every((d) => d instanceof w.HTMLButtonElement && d.type === 'button'));

  track.scrollLeft = 400; // active slide index 4
  track.dispatchEvent(new w.Event('scroll'));

  assert.ok(dots[4].classList.contains('active'), 'active dot marked');
  assert.ok(!dots[4].classList.contains('fade'), 'active dot is never faded');
  // dots within DOT_WINDOW of the active stay opaque
  [2, 3, 4, 5, 6].forEach((j) => assert.ok(!dots[j].classList.contains('fade'), `dot ${j} near active`));
  // dots far from the active fade out (and collapse)
  [0, 1, 7, 8, 9].forEach((j) => assert.ok(dots[j].classList.contains('fade'), `dot ${j} faded`));
});

test('dot click scrolls to that slide and re-marks the active dot', () => {
  const { w } = buildCarousel({ visible: 4 });
  evalCarousel(w);
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const { scrolls } = spyTimers(w, track);
  const nav = w.document.getElementById('cr-dots');
  const dots = [...nav.querySelectorAll('.carousel-dot')];
  dots[2].click();
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].left, 200);
  assert.equal(scrolls[0].behavior, 'smooth');
  assert.equal(track.scrollLeft, 200);
  assert.equal(dots[2].getAttribute('aria-current'), 'true');
  assert.ok(dots[2].classList.contains('active'));
});

test('pointer drag scrolls the track and snaps to the nearest slide on release', () => {
  const { w } = buildCarousel({ visible: 4 });
  evalCarousel(w);
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const { scrolls } = spyTimers(w, track);
  track.dispatchEvent(new w.PointerEvent('pointerdown', { clientX: 0 }));
  track.dispatchEvent(new w.PointerEvent('pointermove', { clientX: -120 })); // drag left 120px
  assert.equal(track.scrollLeft, 120, 'track followed the drag');
  w.window.dispatchEvent(new w.PointerEvent('pointerup', { clientX: -120 }));
  assert.equal(scrolls.length, 1, 'released once');
  assert.equal(scrolls[0].left, 100, 'snapped to nearest slide (index 1)');
  assert.equal(scrolls[0].behavior, 'smooth');
});

test('pointerdown on a link does not start a drag', () => {
  const { w } = buildCarousel({ visible: 4 });
  evalCarousel(w);
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const first = track.querySelector('article');
  const a = w.document.createElement('a');
  a.href = 'https://example.com/1';
  first.appendChild(a);
  // drag-start on the link: carousel must bail and leave the link alone
  a.dispatchEvent(new w.PointerEvent('pointerdown', { clientX: 0 }));
  track.dispatchEvent(new w.PointerEvent('pointermove', { clientX: -200 }));
  assert.equal(track.scrollLeft, 0, 'did not scroll when drag began on a link');
});

test('drag stops autoplay permanently', () => {
  const { w } = buildCarousel({ search: '?carousel=1&autoplay=1', visible: 4 });
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const { intervals, clears } = spyTimers(w, track);
  evalCarousel(w);
  assert.equal(intervals.length, 1, 'autoplay started');

  track.dispatchEvent(new w.PointerEvent('pointerdown', { clientX: 0 }));
  track.dispatchEvent(new w.PointerEvent('pointermove', { clientX: -50 }));
  w.window.dispatchEvent(new w.PointerEvent('pointerup', { clientX: -50 }));

  assert.equal(clears.length, 1, 'drag cleared timer');
  // pointerleave should NOT restart because userStopped is now true
  track.dispatchEvent(new w.Event('pointerleave'));
  assert.equal(intervals.length, 1, 'did not restart after drag');
});

test('autoplay starts only when carousel is active AND ?autoplay=1 AND not reduced-motion', () => {
  const make = ({ search, cr, reduced }) => {
    const { w } = buildCarousel({ search, visible: 4, cr, reduced });
    const track = w.document.querySelector('[data-desks]');
    Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
    const { intervals } = spyTimers(w, track);
    evalCarousel(w);
    return intervals.length;
  };
  assert.equal(make({ search: '?carousel=1&autoplay=1', cr: true, reduced: false }), 1, 'started');
  assert.equal(make({ search: '?autoplay=1', cr: false, reduced: false }), 0, 'needs ?carousel=1');
  assert.equal(make({ search: '?carousel=1&autoplay=1', cr: true, reduced: true }), 0, 'respects reduced motion');
  assert.equal(make({ search: '?carousel=1', cr: true, reduced: false }), 0, 'needs ?autoplay=1');
});

test('autoplay pauses on hover / focus and resumes on leave / blur', () => {
  const { w } = buildCarousel({ search: '?carousel=1&autoplay=1', visible: 4 });
  const track = w.document.querySelector('[data-desks]');
  const nav = w.document.getElementById('cr-dots');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const { intervals, clears } = spyTimers(w, track);
  evalCarousel(w);
  assert.equal(intervals.length, 1);

  track.dispatchEvent(new w.Event('pointerenter'));
  assert.equal(clears.length, 1, 'paused on hover');

  track.dispatchEvent(new w.Event('pointerleave'));
  assert.equal(intervals.length, 2, 'resumed on leave');

  nav.dispatchEvent(new w.Event('focusin'));
  assert.equal(clears.length, 2, 'paused on focus');

  nav.dispatchEvent(new w.Event('focusout'));
  assert.equal(intervals.length, 3, 'resumed on blur');
});

test('dot click stops autoplay permanently', () => {
  const { w } = buildCarousel({ search: '?carousel=1&autoplay=1', visible: 4 });
  const track = w.document.querySelector('[data-desks]');
  const nav = w.document.getElementById('cr-dots');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const { intervals, clears } = spyTimers(w, track);
  evalCarousel(w);
  const dots = [...nav.querySelectorAll('.carousel-dot')];
  assert.equal(intervals.length, 1, 'autoplay started');

  dots[1].click();
  assert.equal(clears.length, 1, 'click cleared timer');
  assert.equal(dots[1].getAttribute('aria-current'), 'true');

  // pointerleave should NOT restart because userStopped is now true.
  track.dispatchEvent(new w.Event('pointerleave'));
  assert.equal(intervals.length, 1, 'did not restart after user click');
});

test('autoplay stops when tab is hidden', () => {
  const { w } = buildCarousel({ search: '?carousel=1&autoplay=1', visible: 4 });
  const track = w.document.querySelector('[data-desks]');
  Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true });
  const { intervals, clears } = spyTimers(w, track);
  evalCarousel(w);
  assert.equal(intervals.length, 1);

  Object.defineProperty(w.document, 'hidden', { value: true, configurable: true, writable: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.equal(clears.length, 1, 'stopped when hidden');
});
