import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

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
  // on the first pack run; fall back to scanning the dir if the name ever changes.
  const linuxDir = path.join('release', 'linux-unpacked');
  const defaultExe = path.join(linuxDir, 'daily-brief');
  if (fs.existsSync(defaultExe)) return path.resolve(defaultExe);
  const entries = fs.readdirSync(linuxDir, { withFileTypes: true }).filter((e) => e.isFile());
  const execs = entries.filter((e) => {
    const name = e.name;
    return !name.startsWith('.') && !name.endsWith('.pak') && !name.endsWith('.dll')
      && !name.endsWith('.so') && !name.endsWith('.json') && !name.endsWith('.txt')
      && !name.endsWith('.html') && !name.endsWith('.md');
  });
  if (execs.length > 0) return path.join(linuxDir, execs[0].name);
  throw new Error(`Packed Linux executable not found in ${linuxDir}`);
}

test('packed app launches, health endpoint answers, window loads', async () => {
  const executablePath = packedExecutablePath();

  const app = await electron.launch({
    executablePath,
    env: { ...process.env, BRIEF_PORT: '4899' },
    // Chromium/Electron refuse to run as root without --no-sandbox on Linux CI;
    // harmless on Windows/macOS.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

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
    await app.close().catch(() => {});
  }
});
