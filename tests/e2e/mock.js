// Stateless, networkless mock "fetch server" for the daily-brief client e2e tests.
//
// Every request the browser makes is intercepted here (page.route('**/*')). No real
// TCP connection is ever made and no external network is touched:
//
//   * / and /brief/:id          -> brief page HTML rendered with the REAL
//                                  server/templates + render.js (fixture data).
//   * /archive                  -> list.html (static).
//   * /static/*                 -> real files from server/public (JS/CSS/vendor).
//   * /api/*                    -> canned JSON; an in-memory fake DB stores
//                                  story liked/saved state (reads + writes).
//   * https://openrouter.ai/*   -> stubbed LLM chat completion (no real call).
//
// Use one MockServer per page (fresh fake DB per test => stateless).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRenderer } from '../../server/lib/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const publicDir = path.join(root, 'server', 'public');

const renderer = makeRenderer({
  templatesDir: path.join(root, 'server', 'templates'),
  cssFile: path.join(root, 'tailwind.css'),
  paperName: 'The Daily Die',
});

const CT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const mime = (ext) => CT[ext] || 'application/octet-stream';

// ---------------------------------------------------------------------------
// Fixture data for the brief page (exercises every template branch).
// ---------------------------------------------------------------------------

function story(id, over = {}) {
  const base = {
    story_id: id, item_id: `item-${id}`, desk: 'primary', position: id - 1,
    headline: `Headline ${id}`, blurb: `Blurb for story number ${id}.`,
    url: `https://example.com/story/${id}`, source: 'Example Source', source_type: 'newslike',
    subtopic: 'ai', age_days: 1, tags: ['ai', 'tech'], kind: 'fresh', summarized: true,
    why_care: `Why story ${id} matters to you.`,
    score_p: 0.8, score_v: 0.6, cos_dist: 0.15, cluster_size: 7, cluster_pool: 19,
    medoid_id: `ps:${id}`, cluster: 'c1', core: 1,
    liked: false, saved: false,
    medoid_title: `Medoid title ${id}`, clusterMedoidTitle: `Medoid title ${id}`,
  };
  return { ...base, ...over };
}

// primary desk: 3 stories covering archive badge / unedited+arxiv / no-ranker-data branches
const PRIMARY = [
  story(1, { position: 0 }),
  story(2, { kind: 'archive', position: 1 }),                                            // 'From the archive' badge
  story(3, { summarized: false, url: 'https://arxiv.org/abs/2601.00001', position: 2 }), // 'Unedited' + alpha link
  story(4, { desk: 'science', position: 0, score_p: null, score_v: null, cos_dist: null,
    cluster_size: null, cluster_pool: null, medoid_id: null, medoid_title: null,
    clusterMedoidTitle: null }),                                                         // no ranker data -> dashes
];
const SCIENCE = [
  story(5, { desk: 'science', position: 0, subtopic: 'physics' }),
  story(6, { desk: 'science', position: 1, kind: 'archive', subtopic: 'physics' }),
];

const DESKS = {
  primary: { title: 'Silicon', deck: 'Today in computing.', stories: PRIMARY },
  science: { title: 'Research', deck: 'Today in science.', stories: SCIENCE },
};

const BRIEF = {
  brief_id: 7, date: '2026-11-10', generated_at: '2026-11-10T08:00:00Z', model: 'test-model',
  edition: 3,
  meta: { model: 'test-model', engine: 'keyword', n_fresh: 3, n_archive: 1,
    n_explore: 0, epsilon: 0.25, pool: 40, sources: 'example, arxiv' },
};

const BRIEFS = [
  { brief_id: 7, date: '2026-11-10', generated_at: '2026-11-10T08:00:00Z', engine: 'keyword' },
  { brief_id: 6, date: '2026-11-09', generated_at: '2026-11-09T08:00:00Z', engine: 'lr' },
];

// Swapped page (what swapToLatest() fetches after a run): deck changes + story 1 liked.
const SWAPPED_DESKS = {
  ...DESKS,
  primary: {
    ...DESKS.primary,
    deck: 'Updated deck after generation.',
    stories: DESKS.primary.stories.map((s, i) => i === 0 ? { ...s, liked: true } : s),
  },
};
const SWAPPED_BRIEF = {
  ...BRIEF,
  meta: { ...BRIEF.meta, engine: 'lr' },
};

const PAGE_HTML = renderer.page({ brief: BRIEF, desks: DESKS, briefs: BRIEFS, embed: false });
const SWAPPED_HTML = renderer.page({ brief: SWAPPED_BRIEF, desks: SWAPPED_DESKS, briefs: BRIEFS, embed: false });
const LIST_HTML = readFileSync(path.join(publicDir, 'list.html'), 'utf8');

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

export class MockServer {
  constructor(page) {
    this.page = page;
    this.likes = new Map();      // key: `${sessionId}:${storyId}` -> true
    this.saves = new Map();      // key: `${sessionId}:${storyId}` -> true
    this.lastSessionId = '';     // session id from the last request
    this.generateCalls = [];     // [{engine, body}]
    this.storyCalls = [];        // [{params}] for /api/stories
    this.statsGenerateCalls = []; // [{cardId}] for /api/restricted/stats/:cardId/generate
    this.jobId = 0;
    this.jobSteps = [];          // ordered responses for current job
    this.jobIdx = 0;
    this.jobLog = '';
    this.jobPolls = [];          // [{id, since, pseq}] for attach/watch assertions
    this._nextPageIsSwapped = false;
    this.failFeedbackStory = null;
    this._generateFails = false;                // when set, /api/restricted/generate starts a failed job
    this._generateFailCode = 1;
    // Config editor mock state.
    this.configCalls = [];                      // [{file, method}]
    this.configSaves = [];                      // [{file, body}]
    this.configResets = [];                     // [{file}]
    this._configSaveFails = false;              // when set, PUT returns 400
    this._configSaveFailCode = 400;
    this._configSaveFailMessage = 'validation failed';
    this._configResetFails = false;             // when set, POST /reset returns 500
    this._configResetFailCode = 500;
    this._configResetFailMessage = 'defaults not found';

    // Fixture config data served by GET /api/config/:file.
    this.configData = {
      'config.json': {
        paper_name: 'The Daily Die',
        stories_per_desk: 5,
        selection: { epsilon: 0.25, archive_after_days: 7 },
        ranker: { engine: 'lr' },
      },
      'sources.json': {
        feeds: { api: { semanticscholar: [] }, rss: [] },
      },
      'perfect_samples.json': [
        { id: '1', title: 'Sample paper', snippet: 'A sample snippet.', type: 'paperlike', core: true, representative: true, desk: 'primary' },
      ],
    };

    // Shipped defaults returned by POST /api/config/:file/reset. Deliberately
    // different from configData so tests can prove the editor was refreshed.
    this.configDefaults = {
      'config.json': {
        paper_name: 'The Daily Die',
        stories_per_desk: 3,
        selection: { epsilon: 0.1, archive_after_days: 14 },
        ranker: { engine: 'keyword' },
      },
      'sources.json': {
        feeds: { api: { semanticscholar: ['default'] }, rss: ['https://default.example/rss'] },
      },
      'perfect_samples.json': [
        { id: 'default', title: 'Default sample', snippet: 'The shipped sample.', type: 'paperlike', core: true, representative: false, desk: 'primary' },
      ],
    };

    // Fixture schemas served by GET /api/config/:file/schema.
    this.configSchemas = {
      'config.json': {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          paper_name: { type: 'string' },
          stories_per_desk: { type: 'integer', minimum: 1 },
          selection: {
            type: 'object',
            properties: {
              epsilon: { type: 'number', minimum: 0, maximum: 1 },
              archive_after_days: { type: 'integer', minimum: 1 },
            },
          },
          ranker: { type: 'object', properties: { engine: { type: 'string' } } },
        },
      },
      'sources.json': { type: 'object' },
      'perfect_samples.json': { type: 'array' },
    };

    this.installRoutes();
  }

  apiFeedsPayload() {
    return {
      days: [
        { date: '2026-11-18', source: 'brief', at: '2026-11-18T08:00:00Z', durationMs: 61000, providerCounts: { openalex: 80, semanticscholar: 12, ieeexplore: 0 }, providerAge: { openalex: 14.2, semanticscholar: 8.4, ieeexplore: null }, totalItems: 92, ok: 5, failed: 1, skipped: 1 },
        { date: '2026-11-19', source: 'brief', at: '2026-11-19T08:00:00Z', durationMs: 58000, providerCounts: { openalex: 95, semanticscholar: 10, ieeexplore: 0 }, providerAge: { openalex: 13.1, semanticscholar: 7.9, ieeexplore: null }, totalItems: 105, ok: 5, failed: 1, skipped: 1 },
        { date: '2026-11-20', source: 'live', at: '2026-11-20T10:00:00Z', durationMs: 54000, providerCounts: { openalex: 87, semanticscholar: 11, ieeexplore: 0 }, providerAge: { openalex: 12.4, semanticscholar: 8.1, ieeexplore: null }, totalItems: 98, ok: 5, failed: 1, skipped: 1 },
      ],
      providers: [
        { key: 'openalex', name: 'OpenAlex' },
        { key: 'semanticscholar', name: 'Semantic Scholar' },
        { key: 'ieeexplore', name: 'IEEE Xplore' },
      ],
      latest: {
        date: '2026-11-20', source: 'live', at: '2026-11-20T10:00:00Z', durationMs: 54000,
        feeds: [
          {
            name: 'OpenAlex — IEEE JSSC', fetcher: 'openalex', provider: 'OpenAlex',
            ok: true, skipped: false, itemCount: 87, error: null, ms: 1200,
            age: {
              dated: 87, undated: 0, min: 1.2, median: 12.4, p90: 40, max: 84,
              buckets: { d0_7: 21, d7_30: 33, d30_90: 30, d90_plus: 3 },
            },
          },
          { name: 'IEEE Xplore — JSSC Early Access', fetcher: 'ieeexplore', provider: 'IEEE Xplore', ok: false, skipped: true, itemCount: 0, age: null, error: 'missing IEEE_XPLORE_API_KEY', ms: 0 },
          { name: 'OpenAlex — CICC', fetcher: 'openalex', provider: 'OpenAlex', ok: false, skipped: false, itemCount: 0, age: null, error: 'HTTP 500', ms: 800 },
        ],
        ok: 1, failed: 1, skipped: 1,
      },
      windowDays: 30,
      recordedDays: 3,
    };
  }

  installRoutes() {
    const { page } = this;
    page.route('**/*', (route, request) => this.handle(route, request));
  }

  async handle(route, request) {
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const sp = url.searchParams;

    // ---- static assets (real files from disk) ----
    if (pathname.startsWith('/static/')) {
      return this.serveFile(route, pathname.slice('/static/'.length));
    }

    // ---- brief page (main document) ----
    if (pathname === '/' || /^\/brief\/\d+$/.test(pathname)) {
      const body = this._alwaysServeSwapped ? SWAPPED_HTML : PAGE_HTML;
      return route.fulfill({
        status: 200,
        body,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ---- archive page ----
    if (pathname === '/archive') {
      return route.fulfill({
        status: 200,
        body: LIST_HTML,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ---- health ----
    if (pathname === '/api/health') {
      return this.json(route, 200, { ok: true, name: 'daily-brief' });
    }

    // ---- briefs list ----
    if (pathname === '/api/briefs') {
      return this.json(route, 200, BRIEFS);
    }
    const mBrief = pathname.match(/^\/api\/briefs\/(\d+)$/);
    if (mBrief) {
      const b = BRIEFS.find((x) => x.brief_id === Number(mBrief[1]));
      return b ? this.json(route, 200, b) : this.json(route, 404, { error: 'no such brief' });
    }

    // ---- job (generation polling) ----
    if (pathname === '/api/job') {
      return this.handleJob(route, sp);
    }

    // ---- stories (archive list + search + filters + paging) ----
    if (pathname === '/api/stories' && method === 'GET') {
      this.lastSessionId = request.headers()['x-session-id'] ?? '';
      this.storyCalls.push(Object.fromEntries(sp));
      return this.json(route, 200, this.listStories(sp, this.lastSessionId));
    }
    if (pathname === '/api/stories/facets' && method === 'GET') {
      return this.json(route, 200, {
        desk: [{ value: 'primary', n: 4 }, { value: 'science', n: 2 }],
        subtopic: [{ value: 'ai', n: 5 }, { value: 'physics', n: 1 }],
        source: [{ value: 'Example Source', n: 4 }, { value: 'Arxiv', n: 1 }],
        tag: [{ value: 'ai', n: 4 }, { value: 'tech', n: 4 }],
      });
    }

    // ---- feedback (like / save) - fake DB write ----
    const mFb = pathname.match(/^\/api\/stories\/(\d+)\/feedback$/);
    if (mFb && method === 'POST') {
      this.lastSessionId = request.headers()['x-session-id'] ?? '';
      return this.handleFeedback(route, Number(mFb[1]), await this.readBody(request), this.lastSessionId);
    }

    // ---- generate ----
    if (pathname === '/api/restricted/generate' && method === 'POST') {
      const body = await this.readBody(request);
      this.generateCalls.push({ engine: body.engine, body });
      if (this._generateFails) {
        this.setFailedJob(this._generateFailCode);
      } else {
        this.startJob(body.engine);
      }
      return this.json(route, 202, { id: this.jobId });
    }

    // ---- stats read: GET /api/stats/:cardId ----
    const mStats = pathname.match(/^\/api\/stats\/([^/]+)$/);
    if (mStats && method === 'GET') {
      const cardId = mStats[1];
      if (cardId === 'lr_metrics') {
        return this.json(route, 200, {
          card: {
            cardId: 'lr_metrics',
            generatedAt: '2026-11-12T10:00:00.000Z',
            sourceHash: 'abc123',
            payload: { cutoffDate: '2026-11-01', tags: [{ tag: 'leaf-mt:q8', prior: { auc: 0.5, logLoss: 0.69 }, keyword: { auc: 0.88, logLoss: 0.38 }, fitted: { auc: 0.70, logLoss: 0.37 } }] },
          },
          outdated: false,
          currentSourceHash: 'abc123',
        });
      }
      if (cardId === 'api_feeds') {
        return this.json(route, 200, {
          card: {
            cardId: 'api_feeds',
            generatedAt: '2026-11-20T10:00:00.000Z',
            sourceHash: 'api123',
            payload: this.apiFeedsPayload(),
          },
          outdated: false,
          currentSourceHash: 'api123',
        });
      }
      // Any other card: not generated yet.
      return this.json(route, 200, { card: null, outdated: true, currentSourceHash: 'x' });
    }

    // ---- stats generate: POST /api/restricted/stats/:cardId/generate ----
    const mStatsGen = pathname.match(/^\/api\/restricted\/stats\/([^/]+)\/generate$/);
    if (mStatsGen && method === 'POST') {
      const cardId = mStatsGen[1];
      this.statsGenerateCalls.push({ cardId, live: sp.get('live') === '1' });
      let payload = {};
      if (cardId === 'lr_metrics') {
        payload = { cutoffDate: '2026-11-01', tags: [{ tag: 'leaf-mt:q8', prior: { auc: 0.5, logLoss: 0.69 }, keyword: { auc: 0.88, logLoss: 0.38 }, fitted: { auc: 0.70, logLoss: 0.37 } }] };
      } else if (cardId === 'api_feeds') {
        payload = this.apiFeedsPayload();
      } else if (cardId === 'clusters') {
        payload = { nClusters: 2, clusters: [
          { cluster: 0, medoid: 'ps:1', medoidTitle: 'Sample paper', likedCount: 3, poolCount: 4, size: 7 },
          { cluster: 1, medoid: 'item-abc', medoidTitle: 'A liked story', likedCount: 5, poolCount: 0, size: 5 },
        ] };
      }
      return this.json(route, 200, {
        cardId,
        generatedAt: new Date().toISOString(),
        sourceHash: 'newhash',
        payload,
      });
    }

    // ---- shutdown ----
    if (pathname === '/api/shutdown' && method === 'POST') {
      return this.json(route, 200, { ok: true });
    }

    // ---- settings page ----
    if (pathname === '/settings' && method === 'GET') {
      let html = readFileSync(path.join(publicDir, 'settings.html'), 'utf8');
      html = html.split('{{basePath}}').join('');
      return route.fulfill({
        status: 200,
        body: html,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ---- statistics page ----
    if (pathname === '/statistics' && method === 'GET') {
      return route.fulfill({
        status: 200,
        body: renderer.statisticsPage({ brief: BRIEF, briefs: BRIEFS }),
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ---- config editor API (GET + PUT + schema + reset) ----
    const mCfg = pathname.match(/^\/api\/config\/([^/]+)(\/schema|\/reset)?$/);
    if (mCfg && (method === 'GET' || method === 'PUT' || method === 'POST')) {
      const fileName = mCfg[1];
      const action = mCfg[2] ?? null;
      const isSchema = action === '/schema';
      const isReset = action === '/reset';
      this.configCalls.push({ file: fileName, method, schema: isSchema, reset: isReset });

      if (isSchema && method === 'GET') {
        return this.json(route, 200, this.configSchemas[fileName] || {});
      }
      if (!action && method === 'GET') {
        return this.json(route, 200, this.configData[fileName] || {});
      }
      if (!action && method === 'PUT') {
        const body = await this.readBody(request);
        this.configSaves.push({ file: fileName, body });
        if (this._configSaveFails) {
          return this.json(route, this._configSaveFailCode, {
            error: this._configSaveFailMessage,
            details: [{ path: 'selection.epsilon', message: 'must be <= 1' }],
          });
        }
        const ts = '2026-11-11T00-00-00Z';
        return this.json(route, 200, {
          ok: true,
          backup: `backups/${fileName}.${ts}.json`,
          note: 'saved; applies on next run',
        });
      }
      if (isReset && method === 'POST') {
        this.configResets.push({ file: fileName });
        if (this._configResetFails) {
          return this.json(route, this._configResetFailCode, {
            error: this._configResetFailMessage,
            details: [{ path: '(root)', message: this._configResetFailMessage }],
          });
        }
        return this.json(route, 200, {
          ok: true,
          backup: `backups/${fileName}.2026-11-11T00-00-00Z.json`,
          path: `C:/Users/test/daily-brief/${fileName}`,
          data: this.configDefaults[fileName] ?? {},
          note: 'reset to defaults; applies on next run',
        });
      }
      return this.json(route, 405, { error: 'method not allowed' });
    }

    // ---- LLM API stub (openrouter) ----
    if (url.hostname.endsWith('openrouter.ai')) {
      return this.json(route, 200, {
        id: 'chatcmpl-test', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"decks":{},"items":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }

    return this.json(route, 404, { error: 'not found' });
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  json(route, code, obj) {
    return route.fulfill({
      status: code,
      body: JSON.stringify(obj),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  async readBody(request) {
    // Playwright route request objects don't emit Node 'data' events; use postData().
    const postData = request.postData() ?? '';
    try { return JSON.parse(postData || '{}'); } catch { return {}; }
  }

  serveFile(route, rel) {
    const file = path.join(publicDir, rel);
    if (!existsSync(file)) {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const body = readFileSync(file);
    return route.fulfill({
      status: 200,
      body,
      headers: { 'Content-Type': mime(path.extname(file)), 'Cache-Control': 'no-store' },
    });
  }

  // ------------------------------------------------------------------
  // Fake DB: story list with filters, search, paging (mirrors queries.js shape)
  // ------------------------------------------------------------------

  listStories(sp, sessionId) {
    const q = (sp.get('q') ?? '').toLowerCase();
    const mark = sp.get('mark');
    const desk = sp.get('desk');
    const subtopic = sp.get('subtopic');
    const source = sp.get('source');
    const tags = sp.getAll('tag').slice(0, 5);

    const rows = [...PRIMARY, ...SCIENCE].filter((r) => {
      if (q && !(r.headline + ' ' + r.blurb + ' ' + r.source + ' ' + r.subtopic).toLowerCase().includes(q)) return false;
      if (mark === 'liked' && !this.isLiked(sessionId, r.story_id)) return false;
      if (mark === 'saved' && !this.isSaved(sessionId, r.story_id)) return false;
      if (mark === 'any' && !(this.isLiked(sessionId, r.story_id) || this.isSaved(sessionId, r.story_id))) return false;
      if (desk && r.desk !== desk) return false;
      if (subtopic && r.subtopic !== subtopic) return false;
      if (source && r.source !== source) return false;
      if (tags.length && !tags.some((t) => r.tags.includes(t))) return false;
      return true;
    });

    const limit = Math.min(Math.max(Number(sp.get('limit')) || 25, 1), 100);
    const offset = Math.max(Number(sp.get('offset')) || 0, 0);
    const pageRows = rows.slice(offset, offset + limit);

    return {
      total: rows.length,
      rows: pageRows.map((r) => ({
        ...r,
        story_id: r.story_id,
        date: '2026-11-10',
        liked: this.isLiked(sessionId, r.story_id),
        saved: this.isSaved(sessionId, r.story_id),
        tags: [...r.tags],
        h_headline: null,
        h_blurb: null,
      })),
    };
  }

  isLiked(sessionId, storyId) { return this.likes.get(`${sessionId}:${storyId}`) === true; }
  isSaved(sessionId, storyId) { return this.saves.get(`${sessionId}:${storyId}`) === true; }
  // Convenience: use the session id from the last request
  liked(storyId) { return this.isLiked(this.lastSessionId, storyId); }
  saved(storyId) { return this.isSaved(this.lastSessionId, storyId); }

  // ------------------------------------------------------------------
  // Fake DB: feedback (like / save) read + write
  // ------------------------------------------------------------------

  async handleFeedback(route, storyId, body, sessionId) {
    const key = `${sessionId}:${storyId}`;
    if (!['like', 'save'].includes(body.action) || typeof body.value !== 'boolean') {
      return this.json(route, 400, { error: 'expected {action:"like"|"save", value:boolean}' });
    }
    if (body.action === 'save') {
      if (body.value) this.saves.set(key, true); else this.saves.delete(key);
    } else {
      if (body.value) this.likes.set(key, true); else this.likes.delete(key);
    }
    return this.json(route, 200, {
      story_id: storyId,
      liked: this.likes.get(key) === true,
      saved: this.saves.get(key) === true,
    });
  }

  // ------------------------------------------------------------------
  // Job simulation (progressive previews, then done -> swapToLatest)
  // ------------------------------------------------------------------

  startJob(engine) {
    this.jobId += 1;
    this.jobIdx = 0;
    this.jobLog = `Generation started (engine=${engine})\n`;
    this.jobSteps = this.buildJobSteps(engine, this.jobId);
  }

  // Seed a job that fails with the given exit code. The next /api/job poll
  // returns status='failed' with error='exit code <n>', so watchJob() surfaces
  // "Generation failed: exit code <n>" and runFlow() takes the failure path.
  setFailedJob(exitCode = 1) {
    this.jobId += 1;
    this.jobIdx = 0;
    this.jobLog = `Generation failed: exit code ${exitCode}\n`;
    this.jobSteps = [
      {
        id: this.jobId, status: 'failed', reset: false,
        error: `exit code ${exitCode}`, log: this.jobLog, offset: this.jobLog.length,
        preview: null,
      },
    ];
  }

  // Make the next /api/restricted/generate call start a failed job (exitCode) instead of
  // a successful one. Call with null to restore normal behaviour.
  setGenerateFails(exitCode = 1) {
    this._generateFails = true;
    this._generateFailCode = exitCode;
  }
  allowGenerate() {
    this._generateFails = false;
  }

  // Make the next config PUT save fail (400). Call with null to restore.
  setConfigSaveFails(exitCode = 400, message = 'validation failed') {
    this._configSaveFails = true;
    this._configSaveFailCode = exitCode;
    this._configSaveFailMessage = message;
  }
  allowConfigSave() {
    this._configSaveFails = false;
  }

  // Make the next config reset fail. Call with null to restore.
  setConfigResetFails(exitCode = 500, message = 'defaults not found') {
    this._configResetFails = true;
    this._configResetFailCode = exitCode;
    this._configResetFailMessage = message;
  }
  allowConfigReset() {
    this._configResetFails = false;
  }

  // Seed a job with id=0 that is already running, so the page's attach fetch
  // (fetch /api/job?id=0&since=0&pseq=-1 on load) picks it up and watches it.
  setRunningJob(engine) {
    this.jobId = 0;
    this.jobIdx = 0;
    this.jobLog = `Generation already running (engine=${engine})\n`;
    this.jobSteps = this.buildJobSteps(engine, 0);
  }

  buildJobSteps(engine, jobId) {
    const t0 = Date.now() / 1000;

    const previewHtml = (desk, items) => {
      const cards = (items || []).map((s) => `
        <article class="story-card story-preview is-preview" data-desk-stories="${desk}">
          <h3 data-story-id="${s.id}">${s.headline}</h3>
          <p>${s.blurb}</p>
        </article>`).join('');
      return `<div data-desk-stories="${desk}" class="is-preview">${cards}</div>`;
    };

    const items = [
      { id: 'p-1', headline: 'Preview story 1', blurb: 'Preview blurb one.', desk: 'primary' },
      { id: 'p-2', headline: 'Preview story 2', blurb: 'Preview blurb two.', desk: 'primary' },
      { id: 's-1', headline: 'Preview science', blurb: 'Science preview.', desk: 'science' },
    ];

    let jobLog = this.jobLog;
    const log = (s) => { jobLog += s + '\n'; return jobLog; };
    const step = (status, preview, extraLog) => {
      if (extraLog) log(extraLog);
      return {
        id: jobId, status, reset: false,
        log: jobLog, offset: jobLog.length, preview,
      };
    };

    return [
      step('running', null, 'selecting...'),
      step('running', { seq: 1, phase: 'selecting', engine, t0, desks: {} }),
      step('running', {
        seq: 2, phase: 'editing', engine, t0,
        desks: {
          primary: { title: 'Silicon', stage: 'pending', working: true, n: 2, deck: '', html: '' },
          science: { title: 'Research', stage: 'pending', working: true, n: 1, deck: '', html: '' },
        },
      }, 'editing...'),
      step('running', {
        seq: 3, phase: 'editing', engine, t0,
        desks: {
          primary: { title: 'Silicon', stage: 'raw', working: false, n: 2, deck: '',
            html: previewHtml('primary', items.slice(0, 2)) },
          science: { title: 'Research', stage: 'pending', working: true, n: 1, deck: '', html: '' },
        },
      }, 'raw winners'),
      step('running', {
        seq: 4, phase: 'editing', engine, t0,
        desks: {
          primary: { title: 'Silicon', stage: 'edited', working: false, n: 2,
            deck: 'Primary deck.', html: previewHtml('primary', items.slice(0, 2)) },
          science: { title: 'Research', stage: 'edited', working: false, n: 1,
            deck: 'Science deck.', html: previewHtml('science', items.slice(1)) },
        },
      }, 'edited'),
      step('running', { seq: 5, phase: 'committing', engine, t0, desks: {} }, 'committing...'),
      { id: jobId, status: 'done', exitCode: 0, reset: false, error: '',
        log: this.jobLog + 'done\n', offset: this.jobLog.length + 9, preview: null },
    ];
  }

  handleJob(route, sp) {
    const id = Number(sp.get('id')) || 0;
    const since = Number(sp.get('since')) || 0;
    const pseq = sp.get('pseq') ?? null;
    this.jobPolls.push({ id, since, pseq });

    const reset = id !== this.jobId;
    let progress = null;
    if (!reset && this.jobSteps.length && this.jobIdx < this.jobSteps.length) {
      progress = { ...this.jobSteps[this.jobIdx] };
      this.jobIdx += 1;
    }

    // If the client polls with a stale job id (e.g. after resetRun() sets jobId=0)
    // but we have a running job, report running so the client re-attaches and continues polling.
    let status = 'idle';
    if (progress) {
      status = progress.status;
    } else if (reset && this.jobSteps.length > 0) {
      status = 'running';
    }

    const response = {
      id: this.jobId,            // Always return our actual job id (client may have a stale one)
      status, reset,
      exitCode: progress ? progress.exitCode : null, error: progress ? progress.error : '',
      log: this.jobLog.slice(since), offset: this.jobLog.length,
    };
    if (progress && progress.preview) response.preview = progress.preview;
    return this.json(route, 200, response);
  }

  // Make the feedback endpoint fail for a given story (tests the optimistic-revert path).
  // Call with null to restore normal behavior.
  failFeedbackFor(storyId) {
    this.failFeedbackStory = storyId;
  }

  async handleFeedback(route, storyId, body, sessionId) {
    if (storyId === this.failFeedbackStory) {
      return this.json(route, 500, { error: 'db down' });
    }
    const key = `${sessionId}:${storyId}`;
    if (!['like', 'save'].includes(body.action) || typeof body.value !== 'boolean') {
      return this.json(route, 400, { error: 'expected {action:"like"|"save", value:boolean}' });
    }
    if (body.action === 'save') {
      if (body.value) this.saves.set(key, true); else this.saves.delete(key);
    } else {
      if (body.value) this.likes.set(key, true); else this.likes.delete(key);
    }
    return this.json(route, 200, {
      story_id: storyId,
      liked: this.likes.get(key) === true,
      saved: this.saves.get(key) === true,
    });
  }

  // Once called, all subsequent '/' requests serve the swapped page (simulates swapToLatest's fetch).
  serveSwappedPage() {
    this._alwaysServeSwapped = true;
  }
}
