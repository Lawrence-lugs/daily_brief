// Opens the brief in an Electron window. The HTTP server runs IN-PROCESS
// (no separate node/python processes required). Run: npx electron electron/main.cjs
const { app, BrowserWindow, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.BRIEF_PORT || 4873);
const ROOT = path.resolve(__dirname, '..');
// Writable per-user app data, shared by `npm run app` and packaged builds so both
// read the same DB and editable config. Pinned before anything reads userData.
app.setPath('userData', path.join(app.getPath('appData'), 'daily-brief'));
const DATA_DIR = app.getPath('userData');
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server = null;
let win = null;


// ---- already-running check -------------------------------------------------
// Returns true when a daily-brief server is already answering on PORT
// (e.g. started by the Obsidian embed or a previous run), so we can reuse it
// instead of crashing with EADDRINUSE.
function alreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try { resolve(JSON.parse(b).name === 'daily-brief'); } catch { resolve(false); }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

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
    const { seedDataDir } = await import('../user/datadir.js');
    seedDataDir(DATA_DIR, ROOT);
    // createApp() reads config.json, opens the SQLite DB, and loads schema.sql.
    // Any of those can throw (missing file, locked DB, bad SQL).

    // Don't start a duplicate server if one is already answering (e.g. launched
    // by the Obsidian embed or a previous run). Reuse it instead of dying with
    // EADDRINUSE, which used to look like a crash. Only open the DB / build the
    // handler when we are the server owner.
    let ownsServer = false;
    if (await alreadyRunning()) {
      log(`reusing existing daily-brief server on ${ORIGIN}`);
      server = null;
    } else {
      const { handler } = createApp({ root: ROOT, dataDir: DATA_DIR, port: PORT });
      server = http.createServer(handler);
      server.listen(PORT, '127.0.0.1', () => {
        ownsServer = true;
        log(`daily-brief listening on http://127.0.0.1:${PORT}`);
      });
      server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          // A server appeared between the check and listen; reuse it.
          try { server.close(); } catch {}
          server = null;
          log(`port ${PORT} now in use by another server; reusing it`);
        } else {
          log(`cannot listen on ${PORT}: ${e.message}`);
          fatalError('Daily Brief — could not start server', e);
        }
      });
    }

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
