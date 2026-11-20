// Settings page against the REAL server (no mock): createApp() + node:http on a
// temp data dir seeded from user/defaults, exactly like Electron's packaged path.
// Catches what the mocked suite (settings.test.js) cannot: route wiring, template
// placeholder substitution, guard rules, real file writes and the vendored jedison bundle.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
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
  // Grid layout: at least one grid row must render (Jedison reads x-format).
  const rowCount = await page.locator('.settings-editor .jedi-row').count();
  expect(rowCount).toBeGreaterThanOrEqual(1);
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
  const reset = await request.post(`${base}/api/config/config.json/reset`);
  expect(reset.status()).toBe(403);
});

test('settings page: reset restores the shipped default and backs up the old file', async ({ page }) => {
  await page.goto(`${base}/settings`);
  await expect.poll(() => page.evaluate(() => typeof window.Jedison)).toBe('object');

  // Make the live config different from the shipped default so the reset is observable.
  const configPath = path.join(dataDir, 'config.json');
  const original = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...original, paper_name: 'Custom Name' }, null, 2) + '\n');
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.Jedison)).toBe('object');

  await page.locator('[id="panel-config.json"] .btn-reset').click();
  await expect(page.locator('#reset-dialog-title')).toHaveText('Reset config.json to defaults?');
  await page.locator('#reset-dialog [data-action="continue"]').click();
  await expect(page.locator('#reset-dialog-title')).toHaveText('Confirm reset of config.json');
  await page.locator('#reset-dialog [data-action="confirm"]').click();

  await expect(page.locator('#toast')).toHaveText(/config\.json reset to defaults/);
  await expect(page.locator('#reset-dialog')).toBeHidden();

  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  const defaults = JSON.parse(readFileSync(path.join(root, 'user', 'defaults', 'config.json'), 'utf8'));
  expect(written).toEqual(defaults);

  const backups = readdirSync(path.join(dataDir, 'backups'))
    .filter((name) => name.startsWith('config.json.'));
  expect(backups.length).toBeGreaterThan(0);
});

test('settings page: raw JSON view saves through the real PUT path', async ({ page }) => {
  await page.goto(`${base}/settings`);
  await expect.poll(() => page.evaluate(() => typeof window.Jedison)).toBe('object');

  await page.locator('[id="panel-config.json"] .view-toggle button[data-view="json"]').click();
  const editor = page.locator('[id="panel-config.json"] .json-editor');
  const value = JSON.parse(await editor.inputValue());
  value.paper_name = 'Raw JSON Paper';
  await editor.fill(JSON.stringify(value, null, 2));
  await page.locator('[id="panel-config.json"] .btn-save').click();

  await expect(page.locator('#toast')).toHaveText(/config\.json saved/);
  const written = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  expect(written.paper_name).toBe('Raw JSON Paper');
});
