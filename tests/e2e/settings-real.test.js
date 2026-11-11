// Settings page against the REAL server (no mock): createApp() + node:http on a
// temp data dir seeded from user/defaults, exactly like Electron's packaged path.
// Catches what the mocked suite (settings.test.js) cannot: route wiring, template
// placeholder substitution, guard rules, real file writes and the vendored jedison bundle.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { seedDataDir } from '../../user/datadir.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4874;
const base = `http://127.0.0.1:${PORT}`;
const FILES = ['config.json', 'sources.json', 'perfect_samples.json'];

let server, dataDir, app;

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'brief-settings-'));
  seedDataDir(dataDir, root);
  app = createApp({ root, dataDir, port: PORT });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
  app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('settings page: jedison bundle loads and all three editors render', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/settings`);
  await expect(page.locator('.tab')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => typeof window.Jedison)).toBe('object');
  for (const f of FILES) {
    await expect(page.locator(`[id="jedison-${f}"]`)).not.toBeEmpty();
  }
  expect(errors).toEqual([]);
});

test('settings page: Back to brief link resolves to a real page', async ({ page }) => {
  await page.goto(`${base}/settings`);
  const href = await page.locator('.back').getAttribute('href');
  expect(href).not.toContain('{{');
  const resp = await page.request.get(new URL(href, `${base}/settings`).toString());
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('text/html');
});

test('settings page: save writes the config file to the data dir', async ({ page }) => {
  await page.goto(`${base}/settings`);
  await expect.poll(() => page.evaluate(() => typeof window.Jedison)).toBe('object');
  const before = readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  await page.locator('.btn-save').first().click();
  await expect(page.locator('#toast')).toHaveText(/config\.json saved/);
  const after = readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  expect(JSON.parse(after)).toEqual(JSON.parse(before));
});

test('config API: mutating request without X-Brief-Client is rejected', async ({ request }) => {
  const resp = await request.put(`${base}/api/config/config.json`, { data: {} });
  expect(resp.status()).toBe(403);
});
