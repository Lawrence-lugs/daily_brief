import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

// Resolve the packed binary path for the current platform. The first real CI
// run will reveal the exact binary name; the helper is adjusted from the
// actual `release/` listing rather than guessed.
function packedExecutablePath() {
  const platform = process.platform;

  if (platform === 'win32') {
    const exe = path.join('release', 'win-unpacked', 'Daily Brief.exe');
    if (fs.existsSync(exe)) return path.resolve(exe);
    throw new Error(`Packed Windows executable not found at ${exe}`);
  }

  if (platform === 'darwin') {
    const macDirs = fs.readdirSync('release').filter((d) => d.startsWith('mac'));
    if (macDirs.length === 0) throw new Error('No release/mac* directory found');
    const appDir = path.join('release', macDirs[0]);
    const apps = fs.readdirSync(appDir).filter((f) => f.endsWith('.app'));
    if (apps.length === 0) throw new Error(`No .app bundle found in ${appDir}`);
    const appPath = path.join(appDir, apps[0]);
    const macosDir = path.join(appPath, 'Contents', 'MacOS');
    const bins = fs.readdirSync(macosDir);
    if (bins.length === 0) throw new Error(`No executable found in ${macosDir}`);
    return path.join(macosDir, bins[0]);
  }

  // linux: productName "Daily Brief" -> executable typically "daily-brief"
  // (derived from package.json "name"). Confirm against `ls release/linux-unpacked`
  // on the first pack run. Try common names, then fall back to scanning the dir
  // for an executable that isn't a known helper binary (e.g. chrome-sandbox).
  const linuxDir = path.join('release', 'linux-unpacked');
  const candidates = [
    path.join(linuxDir, 'daily-brief'),
    path.join(linuxDir, 'Daily-Brief'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  const NON_ELECTRON = new Set(['chrome-sandbox', 'xdg-utils', 'chrome-wrapper']);
  const entries = fs.readdirSync(linuxDir, { withFileTypes: true }).filter((e) => e.isFile());
  const execs = entries.filter((e) => {
    const name = e.name;
    if (NON_ELECTRON.has(name)) return false;
    return !name.startsWith('.') && !name.endsWith('.pak') && !name.endsWith('.dll')
      && !name.endsWith('.so') && !name.endsWith('.json') && !name.endsWith('.txt')
      && !name.endsWith('.html') && !name.endsWith('.md') && !name.endsWith('.dat')
      && !name.endsWith('.bin');
  });
  // Prefer an entry whose name matches the package name.
  const preferred = execs.find((e) => e.name === 'daily-brief' || e.name === 'Daily-Brief');
  if (preferred) return path.join(linuxDir, preferred.name);
  if (execs.length > 0) return path.join(linuxDir, execs[0].name);
  throw new Error(`Packed Linux executable not found in ${linuxDir}`);
}

// Run a promise with a hard timeout so a hung Electron launch / close cannot
// block the whole test (the in-process HTTP server keeps the Node event loop
// alive, so `app.close()` may never resolve on headless Linux CI).
function withTimeout(promise, ms, msg) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function freshUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-brief-packed-'));
  // Seed the throwaway data dir with the real pool so selection has items.
  // dryRun: true (P2) means nothing is written back; real DB is read-only.
  try {
    fs.copyFileSync(
      path.join(process.env.APPDATA, 'daily-brief', 'daily_brief.db'),
      path.join(dir, 'daily_brief.db'),
    );
  } catch {}
  return dir;
}

// Small Node http client for polling the in-process server of the packed app.
// The test file runs in Node (not the browser), so we can hit the server directly.
function request(port, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { 'content-type': 'application/json', 'x-brief-client': '1' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('packed app launches, health endpoint answers, window loads', async () => {
  const executablePath = packedExecutablePath();

  const busy = await fetch('http://127.0.0.1:4899/api/health').then(() => true, () => false);
  if (busy) throw new Error('port 4899 is already in use; close the running daily-brief before running packed tests');

  const app = await withTimeout(
    electron.launch({
      executablePath,
      env: { ...process.env, BRIEF_PORT: '4899', BRIEF_USER_DATA: freshUserData() },
      // Chromium/Electron refuse to run as root without --no-sandbox on Linux CI;
      // harmless on Windows/macOS.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
    30000,
    'electron.launch timed out',
  );

  try {
    // Poll the health endpoint until the in-process server answers.
    const deadline = Date.now() + 60000;
    let health;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('http://127.0.0.1:4899/api/health');
        if (res.ok) {
          health = await res.json();
          break;
        }
      } catch {
        // server not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(health).toBeDefined();
    expect(health.name).toBe('daily-brief');

    const win = await app.firstWindow({ timeout: 60000 });
    await win.waitForLoadState('domcontentloaded');
    expect(await win.title()).toBeTruthy();
    expect(await win.locator('body').count()).toBeGreaterThan(0);
    expect(await win.locator('body').innerText()).not.toBe('');
  } finally {
    // Best-effort close: never let a hung shutdown fail the test. The assertions
    // above already validated launch + health + window load. The in-process HTTP
    // server keeps the Node event loop alive, so `app.close()` may never resolve
    // on headless Linux CI.
    await withTimeout(app.close().catch(() => {}), 15000, 'app.close timed out').catch(() => {});
  }
});

test('packed app generation completes: /api/restricted/generate returns status done', async () => {
  const executablePath = packedExecutablePath();

  const busy = await fetch('http://127.0.0.1:4899/api/health').then(() => true, () => false);
  if (busy) throw new Error('port 4899 is already in use; close the running daily-brief before running packed tests');

  const app = await withTimeout(
    electron.launch({
      executablePath,
      env: { ...process.env, BRIEF_PORT: '4899', BRIEF_USER_DATA: freshUserData() },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
    30000,
    'electron.launch timed out',
  );

  try {
    // Wait for the in-process HTTP server to answer.
    const healthDeadline = Date.now() + 60000;
    while (Date.now() < healthDeadline) {
      try {
        const res = await fetch('http://127.0.0.1:4899/api/health');
        if (res.ok) break;
      } catch {
        // server not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Start a real generation job: no fetch, dry run, no LLM (fast, no network).
    const gen = await request(4899, '/api/restricted/generate', 'POST', {
      noFetch: true,
      dryRun: true,
      noLlm: true,
    });
    expect(gen.status).toBe(202);
    const jobId = gen.json.id;
    expect(typeof jobId).toBe('number');

    // Poll /api/job until the job leaves the running state.
    const deadline = Date.now() + 120000;
    let job;
    while (Date.now() < deadline) {
      job = await request(4899, `/api/job?id=${jobId}`);
      if (!job.json || job.json.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(job).toBeDefined();
    expect(job.json.status).toBe('done');
    expect(job.json.exitCode).toBe(0);
  } finally {
    await withTimeout(app.close().catch(() => {}), 15000, 'app.close timed out').catch(() => {});
  }
});
