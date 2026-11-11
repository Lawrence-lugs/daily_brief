// Request handler for the daily-brief server (node:http only, no framework).
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { openDb, makeQueries } from './lib/queries.js';
import { makeRenderer } from './lib/render.js';
import { JobRunner } from './lib/jobs.js';
import { buildPreview } from './lib/progress.js';
import { guard } from './lib/guard.js';
import { handleConfigRoutes } from '../user/routes.js';
import { seedDataDir, defaultDataDir } from '../user/datadir.js';
import { loadConfig } from '../user/config.js';

const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {{root:string, port:number, dataDir?:string, basePath?:string}} o  root = project dir holding user/defaults/; dataDir = writable per-user dir for the SQLite DB and editable config (Electron packaged builds); basePath = URL prefix stripped from requests (defaults to BRIEF_BASE_PATH env, empty = current behaviour) */
export function createApp({ root, port, onShutdown, dataDir, basePath: optBasePath }) {
  // Mutable per-user data (DB, config.json, sources.json, perfect_samples.json) lives in
  // dataDir; falls back to root for tests when dataDir is not provided.
  const dbDir = dataDir ?? root;
  const basePath = (optBasePath ?? process.env.BRIEF_BASE_PATH ?? '').replace(/\/+$/, '');
  // Public hostnames the hosted deployment is reached on (e.g. behind Traefik). Empty = localhost only.
  const allowedHosts = (process.env.BRIEF_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const cfg = loadConfig(dbDir, 'config.json') ?? {};
  const db = openDb(path.resolve(dbDir, cfg.db_file ?? 'daily_brief.db'), path.join(root, 'schema.sql'));
  const q = makeQueries(db, dbDir);
  const renderer = makeRenderer({
    templatesDir: path.join(root, 'server', 'templates'),
    cssFile: path.join(root, 'tailwind.css'),
    paperName: cfg.paper_name ?? 'The Daily Brief',
    basePath,
  });
  const jobs = new JobRunner({ cwd: root, dataDir: dbDir });
  const publicDir = path.join(root, 'server', 'public');

  const send = (res, code, body, type) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

  async function readJson(req, limit = 16 * 1024) {
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  const SESSION_COOKIE_RE = /(?:^|;\s*)db-session-id=([A-Za-z0-9_-]{8,128})(?:;|$)/;
  function sessionIdFromCookie(cookieHeader) {
    const m = SESSION_COOKIE_RE.exec(cookieHeader ?? '');
    return m ? m[1] : '';
  }

  function servePage(res, url, briefId, sessionId) {
    const id = briefId ?? q.latestBriefId(DATE_RE.test(url.searchParams.get('date') ?? '') ? url.searchParams.get('date') : null)
      ?? q.latestBriefId(null);
    const data = id ? q.getBrief(id, sessionId) : null;
    if (id && !data) return json(res, 404, { error: 'no such brief' });

    // Medoid titles come from the per-story snapshot (medoid_id, taken at generation time).
    if (data) {
      for (const desk of Object.values(data.desks)) {
        for (const story of desk.stories) {
          if (!story.medoid_id) continue;
          story.medoid_title = q.medoidTitle(story.medoid_id);
          story.clusterMedoidTitle = story.medoid_title;   // keeps the existing cluster badge tooltip correct
        }
      }
    }

    // LEGACY fallback (briefs made before the snapshot existed): live interests, may be stale.
    if (data && data.brief && data.brief.meta?.engine === 'lr') {
      const interests = q.getInterestsWithMedoidTitles();
      if (interests) {
        const clusterById = new Map(interests.clusters.map((c) => [c.id, c]));
        for (const desk of Object.values(data.desks)) {
          for (const story of desk.stories) {
            if (story.medoid_id) continue;   // already resolved from the snapshot
            if (story.cluster !== undefined && story.cluster !== null) {
              // DB stores cluster as TEXT, but interests uses numeric IDs
              const clusterKey = Number(story.cluster);
              const cluster = clusterById.get(clusterKey);
              if (cluster) {
                story.clusterMedoidTitle = cluster.medoidTitle;
                story.clusterCore = cluster.core;
                story.clusterSize = cluster.size;
              }
            }
          }
        }
      }
    }

    const html = renderer.page({
      brief: data?.brief ?? null, desks: data?.desks ?? null,
      briefs: q.listBriefs(30), embed: url.searchParams.get('embed') === '1',
      topN: Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get('n') ?? '', 10) || 5)),
    });
    send(res, 200, html, 'text/html; charset=utf-8');
  }

  function serveStatic(res, rel) {
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'forbidden' });
    if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      const denied = guard(req, port, isWrite, allowedHosts);
      if (denied) return json(res, 403, { error: denied });
      const p = url.pathname;
      let m;

      // Session id: client-generated UUID stored in localStorage, sent as X-Session-Id (XHR) and
      // mirrored in the db-session-id cookie so plain page navigations (which can't set headers) get it too.
      // Empty/missing means no session (all like/saved show as false).
      const sessionId = req.headers['x-session-id'] ?? sessionIdFromCookie(req.headers.cookie);

      // ---- base-path handling -----------------------------------------------------------
      // When BRIEF_BASE_PATH is set, Traefik forwards the full PathPrefix path. Strip it here.
      // A bare base path (/dailydie) redirects to /dailydie/. Anything outside the prefix 404s.
      if (basePath) {
        if (p === basePath) {
          res.writeHead(302, { 'Location': basePath + '/', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        if (!p.startsWith(basePath + '/')) return json(res, 404, { error: 'not found' });
      }
      const routePath = basePath ? p.slice(basePath.length) : p;
      // Hosted (prefixed) deployments are stateless: no generation or remote shutdown. Likes/saves are per-session (X-Session-Id), so they stay enabled.
      if (basePath && req.method === 'POST' && /^\/api\/(shutdown|generate)$/.test(routePath)) return json(res, 404, { error: 'not found' });

      // Config editor API (GET + PUT). Handled before the method split so PUT works too.
      if (routePath.startsWith('/api/config/')) return handleConfigRoutes(req, res, routePath, dbDir);

      if (req.method === 'GET') {
        if (routePath === '/' ) return servePage(res, url, null, sessionId);
        if ((m = routePath.match(/^\/brief\/(\d+)$/))) return servePage(res, url, Number(m[1]), sessionId);
        if (routePath === '/api/health') return json(res, 200, { ok: true, name: 'daily-brief' });
        if (routePath === '/archive') {
          let html = readFileSync(path.join(publicDir, 'list.html'), 'utf8');
          if (basePath) html = html.replace('</head>', `<base href="${basePath}/">\n</head>`);
          html = html.replace('<body>', `<body data-base="${basePath}"${basePath ? ' data-hosted="1"' : ''}>`);
          return send(res, 200, html, 'text/html; charset=utf-8');
        }
        if (routePath === '/settings') {
          let html = readFileSync(path.join(publicDir, 'settings.html'), 'utf8');
          html = html.split('{{basePath}}').join(basePath);
          return send(res, 200, html, 'text/html; charset=utf-8');
        }
        if (routePath === '/api/stories') return json(res, 200, q.listStories(url.searchParams));
        if (routePath === '/api/stories/facets') return json(res, 200, q.facets());
        if (routePath === '/api/briefs') return json(res, 200, q.listBriefs(Math.min(Number(url.searchParams.get('limit')) || 30, 200)));
        if ((m = routePath.match(/^\/api\/briefs\/(\d+)$/))) {
          const d = q.getBrief(Number(m[1]), sessionId);
          return d ? json(res, 200, d) : json(res, 404, { error: 'no such brief' });
        }
        if (routePath === '/api/job') {
          const v = jobs.view(Number(url.searchParams.get('id')), url.searchParams.get('since'), url.searchParams.get('pseq'));
          if (v.progress) v.preview = buildPreview(v.progress, { renderStory: renderer.renderStory, medoidTitle: q.medoidTitle });
          delete v.progress;
          return json(res, 200, v);
        }
        if (routePath === '/api/export/training.jsonl') {
          const lines = q.trainingRows().map((r) => JSON.stringify({ ...r, y_like: r.liked, y_save: r.saved }));
          return send(res, 200, lines.join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson; charset=utf-8');
        }
        if (routePath.startsWith('/static/')) return serveStatic(res, routePath.slice('/static/'.length));
      } else if (req.method === 'POST') {
        if ((m = routePath.match(/^\/api\/stories\/(\d+)\/feedback$/))) {
          const body = await readJson(req);
          if (!['like', 'save'].includes(body.action) || typeof body.value !== 'boolean') {
            return json(res, 400, { error: 'expected {action:"like"|"save", value:boolean}' });
          }
          const r = q.setFeedback(Number(m[1]), sessionId, body.action, body.value);
          return r ? json(res, 200, r) : json(res, 404, { error: 'no such story' });
        }
        if (routePath === '/api/generate') {
          const body = await readJson(req);
          const r = jobs.start({ noLlm: body.noLlm === true, noFetch: body.noFetch === true, engine: body.engine });
          return r.ok ? json(res, 202, { id: r.id }) : json(res, 409, { error: 'a generation is already running' });
        }
        if (routePath === '/api/shutdown') {
          // Clean off-switch for the background server. Guarded like any other write (requires the
          // X-Brief-Client header, which a foreign origin cannot forge due to the missing CORS
          // preflight response). Respond first, then shut down once the response is on its way.
          json(res, 200, { ok: true });
          res.on('finish', () => { if (typeof onShutdown === 'function') onShutdown(); });
          return;
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, e.status ?? 500, { error: e.message ?? String(e) });
    }
  }

  return { handler, close: () => db.close(), shutdown: onShutdown, db, jobs };
}
