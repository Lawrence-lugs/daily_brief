import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

// Stateless, networkless e2e tests for the daily-brief client.
// Every request from the browser is intercepted by tests/e2e/mock.js (a fake
// fetch server): real HTML/JS/CSS is served from disk, every API endpoint is
// canned, the DB is an in-memory fake, and openrouter.ai (LLM) is stubbed.
// No external network is ever used; Chromium comes from the ms-playwright cache.

function findChromium() {
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  // Best effort: pick the highest chromium revision with a chrome.exe.
  let best = null;
  try {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('chromium-')) continue;
      const exe = path.join(cacheDir, entry.name, 'chrome-win64', 'chrome.exe');
      if (existsSync(exe)) {
        const rev = Number(entry.name.split('-')[1] || 0);
        if (!best || rev > best.rev) best = { rev, exe };
      }
    }
  } catch { /* cache may not exist */ }
  return best?.exe;
}

const chromiumExe = findChromium() ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');

export default defineConfig({
  testDir: 'tests/e2e',
  // One worker keeps the in-memory fake DB per-test isolation easy to reason about.
  workers: 1,
  fullyParallel: false,
  use: {
    browserName: 'chromium',
    headless: true,
    executablePath: chromiumExe || undefined,
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    // Give the debounced search input and the job-polling loop time to settle.
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  reporter: 'list',
});
