// Request handler for the daily-brief server (node:http only, no framework).
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { openDb, makeQueries } from './lib/queries.js';
import { makeRenderer } from './lib/render.js';
import { JobRunner } from './lib/jobs.js';
import { guard } from './lib/guard.js';

const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {{root:string, port:number, python?:string}} o  root = project dir holding config.json */
export function createApp({ root, port, python = process.env.BRIEF_PYTHON ?? 'python', onShutdown }) {
  const cfg = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
  const db = openDb(path.resolve(root, cfg.db_file ?? 'daily_brief.db'), path.join(root, 'schema.sql'));
  const q = makeQueries(db);
  const renderer = makeRenderer({
    templatesDir: path.join(root, 'server', 'templates'),
    cssFile: path.join(root, 'tailwind.css'),
    paperName: cfg.paper_name ?? 'The Daily Brief',
  });
  const jobs = new JobRunner({ python, script: path.join(root, 'src', 'brief.py'), cwd: root });
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

  function servePage(res, url, briefId) {
    const id = briefId ?? q.latestBriefId(DATE_RE.test(url.searchParams.get('date') ?? '') ? url.searchParams.get('date') : null)
      ?? q.latestBriefId(null);
    const data = id ? q.getBrief(id) : null;
    if (id && !data) return json(res, 404, { error: 'no such brief' });
    const html = renderer.page({
      brief: data?.brief ?? null, desks: data?.desks ?? null,
      briefs: q.listBriefs(30), embed: url.searchParams.get('embed') === '1',
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
      const denied = guard(req, port, isWrite);
      if (denied) return json(res, 403, { error: denied });
      const p = url.pathname;
      let m;

      if (req.method === 'GET') {
        if (p === '/' ) return servePage(res, url, null);
        if ((m = p.match(/^\/brief\/(\d+)$/))) return servePage(res, url, Number(m[1]));
        if (p === '/api/health') return json(res, 200, { ok: true, name: 'daily-brief' });
        if (p === '/api/briefs') return json(res, 200, q.listBriefs(Math.min(Number(url.searchParams.get('limit')) || 30, 200)));
        if ((m = p.match(/^\/api\/briefs\/(\d+)$/))) {
          const d = q.getBrief(Number(m[1]));
          return d ? json(res, 200, d) : json(res, 404, { error: 'no such brief' });
        }
        if (p === '/api/job') {
          return json(res, 200, jobs.view(Number(url.searchParams.get('id')), url.searchParams.get('since')));
        }
        if (p === '/api/export/training.jsonl') {
          const lines = q.trainingRows().map((r) => JSON.stringify({ ...r, y_like: r.liked, y_save: r.saved }));
          return send(res, 200, lines.join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson; charset=utf-8');
        }
        if (p.startsWith('/static/')) return serveStatic(res, p.slice('/static/'.length));
      } else if (req.method === 'POST') {
        if ((m = p.match(/^\/api\/stories\/(\d+)\/feedback$/))) {
          const body = await readJson(req);
          if (!['like', 'save'].includes(body.action) || typeof body.value !== 'boolean') {
            return json(res, 400, { error: 'expected {action:"like"|"save", value:boolean}' });
          }
          const r = q.setFeedback(Number(m[1]), body.action, body.value);
          return r ? json(res, 200, r) : json(res, 404, { error: 'no such story' });
        }
        if (p === '/api/generate') {
          const body = await readJson(req);
          const r = jobs.start({ noLlm: body.noLlm === true, noFetch: body.noFetch === true, engine: body.engine });
          return r.ok ? json(res, 202, { id: r.id }) : json(res, 409, { error: 'a generation is already running' });
        }
        if (p === '/api/shutdown') {
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
