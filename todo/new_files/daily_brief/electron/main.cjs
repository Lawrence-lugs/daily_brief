// Opens the brief in an Electron window. The server runs as a SEPARATE system `node` process
// (so node:sqlite does not depend on Electron's bundled Node). Run: npx electron electron/main.cjs
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.BRIEF_PORT || 4873);
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server = null;

const health = () => new Promise((resolve) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => { try { resolve(JSON.parse(b).name === 'daily-brief'); } catch { resolve(false); } });
  });
  r.on('error', () => resolve(false));
  r.on('timeout', () => { r.destroy(); resolve(false); });
});

async function ensureServer() {
  if (await health()) return;
  server = spawn(process.env.BRIEF_NODE || 'node', [path.join(ROOT, 'server', 'index.js'), '--port', String(PORT)],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await health()) return; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('daily-brief server did not start');
}

app.whenReady().then(async () => {
  await ensureServer();
  const win = new BrowserWindow({ width: 1280, height: 900 });
  const external = (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); external(url); } });
  win.loadURL(`${ORIGIN}/`);
});
app.on('window-all-closed', () => { if (server) server.kill(); app.quit(); });
