#!/usr/bin/env node
// Ensure the local daily-brief server is running before proceeding.
// Mirrors obsidian/daily-brief.md: spawns `node server/index.js` if /api/health is not healthy.
// Usage: node scripts/ensure-server.js   (exits 0 when the server is up, nonzero if it cannot start)
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BRIEF_PORT || 4873);
const HOST = '127.0.0.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const healthy = () => new Promise((resolve) => {
  const req = http.get({ host: HOST, port: PORT, path: '/api/health', timeout: 800 }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b).name === 'daily-brief'); } catch { resolve(false); } });
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

async function ensureServer() {
  if (await healthy()) {
    console.log(`daily-brief server already running on http://${HOST}:${PORT}`);
    return true;
  }
  let child;
  try {
    child = spawn(process.env.BRIEF_NODE || 'node', [path.join(root, 'server', 'index.js'), '--port', String(PORT)],
      { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  } catch (e) {
    console.error(`Could not start node: ${e.message}`);
    return false;
  }
  child.on('error', (e) => { console.error(`Could not start node: ${e.message}`); });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await healthy()) {
      console.log(`daily-brief server started on http://${HOST}:${PORT}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error('daily-brief server did not start');
  return false;
}

const ok = await ensureServer();
process.exit(ok ? 0 : 1);
