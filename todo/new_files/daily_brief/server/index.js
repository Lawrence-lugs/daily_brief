#!/usr/bin/env node
// Usage: node server/index.js [--port 4873]
// Exits 0 immediately if a daily-brief server is already answering on that port.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--port');
const port = Number(i > -1 ? process.argv[i + 1] : process.env.BRIEF_PORT ?? 4873);
const host = '127.0.0.1'; // never bind a public interface

function alreadyRunning() {
  return new Promise((resolve) => {
    const r = http.get({ host, port, path: '/api/health', timeout: 800 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b).name === 'daily-brief'); } catch { resolve(false); } });
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

if (await alreadyRunning()) {
  console.log(`daily-brief already running on http://${host}:${port}`);
  process.exit(0);
}
const app = createApp({ root, port });
const server = http.createServer(app.handler);
server.on('error', (e) => { console.error(`cannot listen on ${host}:${port}: ${e.message}`); process.exit(1); });
server.listen(port, host, () => console.log(`daily-brief listening on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); app.close(); process.exit(0); });
