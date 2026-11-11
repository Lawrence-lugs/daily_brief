import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { seedDataDir } from '../../user/datadir.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4876;
const base = `http://127.0.0.1:${PORT}`;

let server, dataDir, app;

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'brief-nav2-'));
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

test('nav link click stays on /settings and switches section', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/settings`);
  await expect.poll(() => page.evaluate(() => typeof window.Jedison)).toBe('object');

  await expect(page.locator('.settings-editor .jedi-nav-list').first()).toBeVisible();

  const links = page.locator('.settings-editor .jedi-nav-link');
  expect(await links.count()).toBeGreaterThan(1);
  const activeItem = page.locator('.settings-editor .jedi-nav-list > li.active').first();
  const activeBefore = await activeItem.textContent();
  const firstPane = page.locator(`[id="${(await links.nth(0).getAttribute('href')).slice(1)}"]`);
  const secondPane = page.locator(`[id="${(await links.nth(1).getAttribute('href')).slice(1)}"]`);
  await expect(firstPane).toBeVisible();
  await expect(secondPane).toBeHidden();

  await links.nth(1).click();
  await page.waitForTimeout(500);

  const after = page.url();
  expect(after).toContain('/settings');
  expect(after).not.toBe(`${base}/`);
  await expect(activeItem).not.toHaveText(activeBefore);
  await expect(firstPane).toBeHidden();
  await expect(secondPane).toBeVisible();
  expect(errors).toEqual([]);
});
