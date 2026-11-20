// Settings page e2e tests.
//
// Exercises every button/use case on the config editor:
//   - Page loads all three config tabs with jedison forms
//   - Tab switching shows/hides panels
//   - Each file is loaded via GET /api/config/:file (+ schema)
//   - Save via PUT persists changes and shows a toast
//   - Save errors surface an error toast
//   - Settings link from the sidebar navigates to /settings
//
// Uses the mocked fetch server (tests/e2e/mock.js): no real network, no real
// filesystem writes (config saves are canned).

import { test, expect } from '@playwright/test';
import { MockServer } from './mock.js';

const waitFor = (fn, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waitFor timed out: ${fn}`)), timeout);
    const iv = setInterval(() => {
      try { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } } catch {}
    }, 40);
  });

const baseUrl = 'http://127.0.0.1:4873';

const FILES = ['config.json', 'sources.json', 'perfect_samples.json'];

// IDs contain dots (config.json), which are CSS class separators. Use attribute selectors.
const panel = (f) => `[id="panel-${f}"]`;
const jedisonRoot = (f) => `[id="jedison-${f}"]`;
const saveBtn = (f) => `.btn-save`;

test.describe('settings page — load', () => {
  test('renders all three config tabs with jedison forms and save buttons', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);

    // All three tabs present.
    await expect(page.locator('.tab')).toHaveCount(3);
    for (const f of FILES) {
      await expect(page.locator('.tab', { hasText: f })).toBeVisible();
    }

    // All three panels present in the DOM; first visible, others hidden.
    for (const f of FILES) {
      await expect(page.locator(panel(f))).toBeAttached();
    }
    await expect(page.locator(panel('config.json'))).toBeVisible();
    await expect(page.locator(panel('sources.json'))).toBeHidden();
    await expect(page.locator(panel('perfect_samples.json'))).toBeHidden();

    // Jedison containers appear for all files; only the active tab's save
    // button is visible (panels for inactive tabs are display:none).
    await expect(page.locator(jedisonRoot('config.json'))).toBeAttached();
    await expect(page.locator(jedisonRoot('sources.json'))).toBeAttached();
    await expect(page.locator(jedisonRoot('perfect_samples.json'))).toBeAttached();
    await expect(page.locator(saveBtn('config.json'), { hasText: 'Save config.json' })).toBeVisible();

    // All three files were fetched.
    const gets = mock.configCalls.filter((c) => c.method === 'GET' && !c.schema);
    expect(gets.map((c) => c.file).sort()).toEqual([...FILES].sort());

    // Schemas were fetched too.
    const schemas = mock.configCalls.filter((c) => c.schema);
    expect(schemas.map((c) => c.file).sort()).toEqual([...FILES].sort());
  });

  test('tab switching shows only the selected panel', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    // Start on config.json.
    await expect(page.locator(panel('config.json'))).toBeVisible();
    await expect(page.locator('.tab.active', { hasText: 'config.json' })).toBeVisible();

    // Switch to sources.json.
    await page.locator('.tab').filter({ hasText: 'sources.json' }).click({ force: true });
    await expect(page.locator('.tab.active')).toHaveCount(1);
    await expect(page.locator('.tab.active').filter({ hasText: 'sources.json' })).toBeVisible();
    await expect(page.locator(panel('config.json'))).toBeHidden();
    await expect(page.locator(panel('sources.json'))).toBeVisible();
    await expect(page.locator(panel('perfect_samples.json'))).toBeHidden();

    // Switch to perfect_samples.json.
    await page.locator('.tab').filter({ hasText: 'perfect_samples.json' }).click({ force: true });
    await expect(page.locator('.tab.active').filter({ hasText: 'perfect_samples.json' })).toBeVisible();
    await expect(page.locator(panel('config.json'))).toBeHidden();
    await expect(page.locator(panel('sources.json'))).toBeHidden();
    await expect(page.locator(panel('perfect_samples.json'))).toBeVisible();

    // Back to config.json.
    await page.locator('.tab').filter({ hasText: 'config.json' }).click({ force: true });
    await expect(page.locator('.tab.active').filter({ hasText: 'config.json' })).toBeVisible();
    await expect(page.locator(panel('config.json'))).toBeVisible();
  });
});

test.describe('settings page — save (PUT)', () => {
  test('saving config.json PUTs and shows a saved toast', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    // Click the config.json save button.
    await page.click(saveBtn('config.json'), { hasText: 'Save config.json' }, { force: true });

    // PUT was recorded with the right file.
    await waitFor(() => mock.configSaves.length === 1);
    expect(mock.configSaves[0].file).toBe('config.json');
    expect(typeof mock.configSaves[0].body).toBe('object');

    // Button shows "Saved" then resets.
    await expect(page.locator(saveBtn('config.json'), { hasText: 'Saved' })).toBeVisible();
    await page.waitForTimeout(1600);
    await expect(page.locator(saveBtn('config.json'), { hasText: 'Save config.json' })).toBeVisible();

    // Toast shows success.
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toHaveText(/config\.json saved/);
  });

  test('saving each file individually records a separate PUT', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    // Save sources.json: switch to its tab first (its button is hidden otherwise).
    await page.locator('.tab').filter({ hasText: 'sources.json' }).click({ force: true });
    await page.locator('.btn-save').filter({ hasText: 'Save sources.json' }).click({ force: true });
    await waitFor(() => mock.configSaves.length === 1);
    expect(mock.configSaves[0].file).toBe('sources.json');

    // Save perfect_samples.json: switch to its tab.
    await page.locator('.tab').filter({ hasText: 'perfect_samples.json' }).click({ force: true });
    await page.locator('.btn-save').filter({ hasText: 'Save perfect_samples.json' }).click({ force: true });
    await waitFor(() => mock.configSaves.length === 2);
    expect(mock.configSaves[1].file).toBe('perfect_samples.json');

    // Save config.json again: switch back.
    await page.locator('.tab').filter({ hasText: 'config.json' }).click({ force: true });
    await page.locator('.btn-save').filter({ hasText: 'Save config.json' }).click({ force: true });
    await waitFor(() => mock.configSaves.length === 3);
    expect(mock.configSaves[2].file).toBe('config.json');
  });

  test('a failed save shows an error toast and re-enables the button', async ({ page }) => {
    const mock = new MockServer(page);
    mock.setConfigSaveFails(400, 'validation failed');
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.click(saveBtn('config.json'), { hasText: 'Save config.json' }, { force: true });
    await waitFor(() => mock.configSaves.length === 1);

    // Error toast shown.
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toHaveText(/Save failed/);
    await expect(page.locator('#toast')).toHaveClass(/error/);

    // Button re-enabled after failure.
    await expect(page.locator(saveBtn('config.json'), { hasText: 'Save config.json' })).toBeVisible();
    await expect(page.locator(saveBtn('config.json'), { hasText: 'Save config.json' })).not.toBeDisabled();
  });

  test('a server error on save shows an error toast', async ({ page }) => {
    const mock = new MockServer(page);
    mock.setConfigSaveFails(500, 'db down');
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.click(saveBtn('config.json'), { hasText: 'Save config.json' }, { force: true });
    await waitFor(() => mock.configSaves.length === 1);

    await expect(page.locator('#toast')).toHaveText(/Save failed.*db down/);
  });
});

test.describe('settings page — reset to defaults', () => {
  test('each file has a reset button that requires two confirmations', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    // All three panels have a reset button; only the active one is visible.
    await expect(page.locator('.btn-reset')).toHaveCount(3);
    await expect(page.locator(`${panel('config.json')} .btn-reset`)).toBeVisible();
    await expect(page.locator(`${panel('sources.json')} .btn-reset`)).toBeHidden();

    await page.locator(`${panel('config.json')} .btn-reset`).click();
    await expect(page.locator('#reset-dialog')).toBeVisible();
    await expect(page.locator('#reset-dialog-title')).toHaveText('Reset config.json to defaults?');
    await expect(page.locator('#reset-dialog-body')).toContainText('desks');
    expect(mock.configResets).toHaveLength(0);

    // First Cancel: no request.
    await page.locator('#reset-dialog [data-action="cancel"]').click();
    await expect(page.locator('#reset-dialog')).toBeHidden();
    expect(mock.configResets).toHaveLength(0);

    // Continue to step two, then cancel again.
    await page.locator(`${panel('config.json')} .btn-reset`).click();
    await page.locator('#reset-dialog [data-action="continue"]').click();
    await expect(page.locator('#reset-dialog-title')).toHaveText('Confirm reset of config.json');
    await expect(page.locator('#reset-dialog-body')).toContainText('no built-in restore button');
    expect(mock.configResets).toHaveLength(0);
    await page.locator('#reset-dialog [data-action="cancel"]').click();
    expect(mock.configResets).toHaveLength(0);
  });

  test('confirming reset POSTs once and refreshes both views', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.locator(`${panel('config.json')} .btn-reset`).click();
    await page.locator('#reset-dialog [data-action="continue"]').click();
    await page.locator('#reset-dialog [data-action="confirm"]').click();

    await waitFor(() => mock.configResets.length === 1);
    expect(mock.configResets[0].file).toBe('config.json');
    await expect(page.locator('#toast')).toHaveText(/config\.json reset to defaults/);
    await expect(page.locator('#reset-dialog')).toBeHidden();

    // The form reflects the defaults; switching to JSON shows them too.
    await page.locator(`${panel('config.json')} .view-toggle button[data-view="json"]`).click();
    const jsonText = await page.locator(`${panel('config.json')} .json-editor`).inputValue();
    expect(jsonText).toContain('"paper_name": "The Daily Die"');
    expect(jsonText).toContain('"stories_per_desk": 3');
  });

  test('a failed reset keeps the dialog open and shows the server error', async ({ page }) => {
    const mock = new MockServer(page);
    mock.setConfigResetFails(500, 'defaults not found');
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.locator(`${panel('config.json')} .btn-reset`).click();
    await page.locator('#reset-dialog [data-action="continue"]').click();
    await page.locator('#reset-dialog [data-action="confirm"]').click();

    await waitFor(() => mock.configResets.length === 1);
    await expect(page.locator('#reset-dialog-error')).toBeVisible();
    await expect(page.locator('#reset-dialog-error')).toHaveText(/Reset failed.*defaults not found/);
    await expect(page.locator('#reset-dialog')).toBeVisible();
    await expect(page.locator('#reset-dialog [data-action="confirm"]')).toBeEnabled();
  });
});

test.describe('settings page — raw JSON view', () => {
  test('toggling to JSON shows pretty-printed data and Format reformats edits', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.locator(`${panel('config.json')} .view-toggle button[data-view="json"]`).click();
    const editor = page.locator(`${panel('config.json')} .json-editor`);
    await expect(editor).toBeVisible();
    await expect(page.locator('[id="jedison-config.json"]')).toBeHidden();
    await expect(editor).toHaveValue(/"paper_name": "The Daily Die"/);

    // Invalid JSON is reported and keeps the JSON view active.
    await editor.fill('{ "paper_name": ');
    await page.locator(`${panel('config.json')} .view-toggle button[data-view="form"]`).click();
    await expect(page.locator(`${panel('config.json')} .json-error`)).toBeVisible();
    await expect(page.locator(`${panel('config.json')} .json-error`)).toHaveText(/Invalid JSON/);
    await expect(editor).toBeVisible();

    // Fix and format.
    await editor.fill('{"paper_name":"Edited","stories_per_desk":4}');
    await page.locator(`${panel('config.json')} .btn-format`).click();
    await expect(editor).toHaveValue(/"paper_name": "Edited"/);
    await expect(page.locator(`${panel('config.json')} .json-error`)).toBeHidden();
  });

  test('saving from the JSON view PUTs the edited object', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.locator(`${panel('config.json')} .view-toggle button[data-view="json"]`).click();
    const editor = page.locator(`${panel('config.json')} .json-editor`);
    await editor.fill(JSON.stringify({ paper_name: 'Edited Paper', stories_per_desk: 4 }, null, 2));
    await page.locator(`${panel('config.json')} .btn-save`).click();

    await waitFor(() => mock.configSaves.length === 1);
    expect(mock.configSaves[0].file).toBe('config.json');
    expect(mock.configSaves[0].body).toEqual({ paper_name: 'Edited Paper', stories_per_desk: 4 });
    await expect(page.locator('#toast')).toHaveText(/config\.json saved/);
  });

  test('invalid JSON blocks save and shows an inline error', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.locator(`${panel('config.json')} .view-toggle button[data-view="json"]`).click();
    await page.locator(`${panel('config.json')} .json-editor`).fill('{ nope');
    await page.locator(`${panel('config.json')} .btn-save`).click();

    await expect(page.locator(`${panel('config.json')} .json-error`)).toHaveText(/Invalid JSON/);
    expect(mock.configSaves).toHaveLength(0);
    await expect(page.locator(`${panel('config.json')} .btn-save`)).toBeEnabled();
  });

  test('the JSON toggle is per file and keeps edits across tab switches', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector(saveBtn('config.json'));

    await page.locator(`${panel('config.json')} .view-toggle button[data-view="json"]`).click();
    const configEditor = page.locator(`${panel('config.json')} .json-editor`);
    await configEditor.fill('{"paper_name":"Kept"}');

    // sources.json is still in Form view.
    await page.locator('.tab').filter({ hasText: 'sources.json' }).click({ force: true });
    await expect(page.locator(`${panel('sources.json')} .json-editor`)).toBeHidden();
    await expect(page.locator(`${panel('sources.json')} .view-toggle button[data-view="form"]`)).toHaveClass(/active/);

    // Back to config.json: the edited JSON is still there.
    await page.locator('.tab').filter({ hasText: 'config.json' }).click({ force: true });
    await expect(configEditor).toBeVisible();
    await expect(configEditor).toHaveValue('{"paper_name":"Kept"}');
  });
});

test.describe('settings page — navigation', () => {
  test('settings link from the sidebar navigates to /settings', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-settings');

    await page.click('#btn-settings', { force: true });
    await expect(page).toHaveURL(/\/settings/);
    await page.waitForSelector('#tabs');
    await expect(page.locator('.tab')).toHaveCount(3);
  });

  test('back to brief link returns to /', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector('.back');
    expect(await page.locator('.back').getAttribute('href')).not.toContain('{{');

    await page.click('.back', { force: true });
    await expect(page).toHaveURL(/\/$/);
  });
});
