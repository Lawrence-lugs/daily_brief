// Opens the brief in an Electron window. The HTTP server runs IN-PROCESS
// (no separate node/python processes required). Run: npx electron electron/main.cjs
const { app, BrowserWindow, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.BRIEF_PORT || 4873);
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server = null;
let win = null;

// ---- single instance -------------------------------------------------------
// Prevent a second launch from leaving an orphaned server/window (the
// "visible only in Task Manager" symptom). If another instance is already
// running, quit immediately; if a second instance is started later, focus the
// existing window instead of spawning a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ---- logging ---------------------------------------------------------------
// On a packaged build there is no console, so write crashes to a log file in
// the user data dir so we can diagnose "invisible" failures after the fact.
const LOG_DIR = app.getPath('userData');
const LOG_FILE = path.join(LOG_DIR, 'main.log');
// Ensure the log dir exists so crashes are actually written to disk on
// packaged builds (no console available there).
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(String).join(' ') + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  try { console.log(...args); } catch {}
}

function fatalError(title, err) {
  const message = err && err.stack ? err.stack : String(err ?? err);
  log('FATAL:', title, '->', message);
  try { dialog.showErrorBox(title, message); } catch {}
  // Never linger with no window: shut down so the process doesn't haunt Task Manager.
  try { if (server) server.close(); } catch {}
  app.quit();
}

app.whenReady().then(async () => {
  try {
    const { createApp } = await import('../server/app.js');
    // createApp() reads config.json, opens the SQLite DB, and loads schema.sql.
    // Any of those can throw (missing file, locked DB, bad SQL).
    const { handler } = createApp({ root: ROOT, port: PORT });
    server = http.createServer(handler);
    server.listen(PORT, '127.0.0.1', () => {
      log(`daily-brief listening on http://127.0.0.1:${PORT}`);
    });
    server.on('error', (e) => {
      log(`cannot listen on ${PORT}: ${e.message}`);
      fatalError('Daily Brief — could not start server', e);
    });

    win = new BrowserWindow({
      width: 1280,
      height: 900,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#4a453f',
        height: 32,
      },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.on('closed', () => { win = null; });

    const external = (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); external(url); } });
    win.loadURL(`${ORIGIN}/`);
  } catch (err) {
    fatalError('Daily Brief — failed to start', err);
  }
}).catch((err) => {
  fatalError('Daily Brief — failed to start', err);
});

app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
