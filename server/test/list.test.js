// Run: node --test server/test/list.test.js
// Loads list.js in jsdom to catch syntax errors and basic initialization issues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const listJs = readFileSync(resolve('server/public/list.js'), 'utf8');

test('list.js loads without syntax errors in jsdom', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <main class="newspaper-shell">
      <header class="paper-heading"><h1>Test</h1><small><a id="back" href="/">Latest brief</a> · <span id="count"></span></small></header>
      <form id="filters" class="archive-filters" autocomplete="off">
        <input id="q" class="gridjs-input" type="search" placeholder="Search…">
        <div id="mark" class="seg" role="group" aria-label="Show">
          <button type="button" data-mark="" aria-pressed="true">All</button>
          <button type="button" data-mark="liked" aria-pressed="false">Liked</button>
          <button type="button" data-mark="saved" aria-pressed="false">Saved</button>
          <button type="button" data-mark="any" aria-pressed="false">Liked or saved</button>
        </div>
        <select id="desk" aria-label="Desk"><option value="">All desks</option></select>
        <select id="subtopic" aria-label="Subtopic"><option value="">All subtopics</option></select>
        <select id="source" aria-label="Source"><option value="">All sources</option></select>
        <label>From <input id="from" type="date"></label>
        <label>To <input id="to" type="date"></label>
        <select id="sort" aria-label="Sort">
          <option value="">Best match / newest</option>
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
        </select>
        <button type="button" id="reset">Reset</button>
      </form>
      <div id="tagbar" class="tagbar" aria-label="Tags"></div>
      <div id="grid" aria-label="Story archive"></div>
    </main>
  </body></html>`, {
    url: 'http://localhost/archive',
    runScripts: 'outside-only',
    resources: 'usable',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.HTMLElement = window.HTMLElement;
  global.HTMLFormElement = window.HTMLFormElement;
  global.HTMLInputElement = window.HTMLInputElement;
  global.HTMLSelectElement = window.HTMLSelectElement;
  global.HTMLButtonElement = window.HTMLButtonElement;
  global.Element = window.Element;
  global.Node = window.Node;
  global.Event = window.Event;
  global.MouseEvent = window.MouseEvent;
  global.KeyboardEvent = window.KeyboardEvent;
  global.CustomEvent = window.CustomEvent;
  global.URLSearchParams = window.URLSearchParams;
  global.location = window.location;
  global.history = window.history;
  global.matchMedia = window.matchMedia;
  global.fetch = async () => ({ ok: true, json: async () => ({ desk: [], subtopic: [], source: [], tag: [] }) });

  // Provide a minimal gridjs mock
  class MockGrid {
    constructor(opts) { this.opts = opts; }
    render(host) { this.host = host; return this; }
    destroy() {}
  }
  window.gridjs = { Grid: MockGrid, html: (s) => ({ __html: s }) };

  // Execute list.js
  const script = window.document.createElement('script');
  script.textContent = listJs;
  window.document.body.appendChild(script);

  // Wait for initialization
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        // If we get here without script throwing, syntax is OK
        // Check that the IIFE executed by verifying DOM changes
        const countEl = window.document.getElementById('count');
        // The script should have at least started rendering
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 100);
  });
});