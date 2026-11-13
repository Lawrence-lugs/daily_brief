import { defineConfig } from '@playwright/test';

// Config for the packed Electron app smoke test. Separate from the normal
// e2e config so the unpacked-repo tests are unaffected. Launches the real
// packaged binary via @playwright/test's `_electron`; no browser project and
// no executablePath (the binary path is resolved in the test helper).
export default defineConfig({
  testDir: 'tests/packed',
  workers: 1,
  reporter: 'list',
  timeout: 120000,
  use: {
    headless: true,
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
});
