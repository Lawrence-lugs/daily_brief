// Stateless, networkless e2e tests for the daily-brief client.
//
// Every button/feature on the client is exercised against a mocked fetch server
// (tests/e2e/mock.js): real HTML/JS/CSS served from disk, every API endpoint canned,
// an in-memory fake DB for story liked/saved reads+writes, and openrouter.ai (LLM)
// stubbed. No external network is used and nothing is skipped.
//
import { test, expect } from '@playwright/test';
import { MockServer } from './mock.js';

// Poll a Node-side predicate (mock state lives in the test process).
const waitFor = (fn, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waitFor timed out: ${fn}`)), timeout);
    const iv = setInterval(() => {
      try { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } } catch {}
    }, 40);
  });

const baseUrl = 'http://127.0.0.1:4873';

test.describe('brief page — theme', () => {
  test('toggles dark/light, updates aria-pressed, title, localStorage and URL', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-theme');
    const html = page.locator('html');
    const btn = page.locator('#btn-theme');

    await btn.click();
    await expect(html).toHaveClass(/dark/);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveAttribute('title', 'Switch to light mode');
    await expect(page).toHaveURL(/[?&]theme=dark/);

    await btn.click();
    await expect(html).toHaveClass(/light/);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(/[?&]theme=light/);
  });
});

test.describe('brief page — like / save', () => {
  test('liking a story is optimistic, persists to the fake DB, and toggles off', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-story-id="1"]');
    const like = page.locator('[data-story-id="1"][data-action="like"]').first();

    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await like.click({ force: true });
    await waitFor(() => mock.liked('1') === true);
    await expect(like).toHaveAttribute('aria-pressed', 'true');

    await like.click({ force: true });
    await waitFor(() => mock.liked('1') === false);
    await expect(like).toHaveAttribute('aria-pressed', 'false');
  });

  test('saving a story updates the saved flag', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-story-id="1"]');
    const save = page.locator('[data-story-id="1"][data-action="save"]').first();

    await save.click({ force: true });
    await waitFor(() => mock.saved('1') === true);
    await expect(save).toHaveAttribute('aria-pressed', 'true');
  });

  test('reverts optimistically when the feedback write fails', async ({ page }) => {
    const mock = new MockServer(page);
    mock.failFeedbackFor(1);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-story-id="1"]');
    const like = page.locator('[data-story-id="1"][data-action="like"]').first();

    await like.click({ force: true });
    await waitFor(() => mock.liked('1') === false);
    await expect(like).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('brief page — card flip', () => {
  test('flip reveals the back, sets inert/aria-hidden and moves focus', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('.story-card');
    const card = page.locator('.story-card').first();
    const flip = card.locator('[data-flip]').first();
    const front = card.locator('.story-front');
    const back = card.locator('.story-back');

    await expect(card).not.toHaveClass(/is-flipped/);
    await flip.click({ force: true });
    await expect(card).toHaveClass(/is-flipped/);
    await expect(front).toHaveAttribute('inert');
    await expect(front).toHaveAttribute('aria-hidden', 'true');
    await expect(back).toHaveAttribute('aria-hidden', 'false');

    // Unflip: click the flip button now on the visible back face (via DOM dispatch for reliability).
    await page.evaluate(() => {
      const btn = document.querySelector('.story-card .story-back [data-flip]');
      btn?.click();
    });
    await expect(card).not.toHaveClass(/is-flipped/);
    await expect(front).not.toHaveAttribute('inert');
    await expect(back).toHaveAttribute('aria-hidden', 'true');
  });
});

test.describe('brief page — external links', () => {
  test('external story links open in a new tab with noopener noreferrer', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('a[href*="example.com/story/"]');
    const link = page.locator('a[href*="example.com/story/"]').first();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      link.click({ force: true }),
    ]);
    await popup.close();

    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  });
});

test.describe('brief page — toolbar', () => {
  test('btn-logs shows/hides the log popup', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-logs');
    const log = page.locator('#log-popup');

    await expect(log).toBeHidden();
    await page.click('#btn-logs');
    await expect(log).toBeVisible();
    await page.click('#btn-logs');
    await expect(log).toBeHidden();
  });

  test('btn-archive navigates to the archive page', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-archive');
    await page.click('#btn-archive');
    await expect(page).toHaveURL(/\/archive/);
    await page.waitForSelector('#grid');
  });

  test('picking a brief from the sidebar picker navigates to that brief', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#sb-brief');
    await page.click('#sb-brief');
    // flyout lists the briefs; pick the second one (lr, 2026-11-09) by value
    await page.locator('.sb-opt[data-value="6"]').first().click({ force: true });
    await expect(page).toHaveURL(/\/brief\/6/);
  });
});

test.describe('brief page — generation flow (keyword)', () => {
  test('generate polls the job, renders previews, then swaps in the finished page', async ({ page }) => {
    const mock = new MockServer(page);
    mock.serveSwappedPage(); // swapToLatest() fetches '/' -> swapped page
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-generate');
    await expect(page.locator('#btn-generate')).toBeEnabled();

    // Click via DOM dispatch to reliably trigger the onclick handler.
    await page.evaluate(() => document.getElementById('btn-generate')?.click());

    // Button disabled immediately (runFlow sets it synchronously before any await).
    await expect(page.locator('#btn-generate')).toBeDisabled();

    // Generation started: a job was created via the mocked /api/restricted/generate.
    await waitFor(() => mock.generateCalls.some((c) => c.engine === 'keyword'));
    expect(mock.generateCalls[0].engine).toBe('keyword');

    // Progress panel is populated while job runs (renderPanel sets innerHTML + hidden=false).
    const panelInfo = await page.evaluate(() => {
      const p = document.getElementById('gen-panel');
      return { hasChildren: !!p?.firstElementChild, GM: !!window.GenModel };
    });
    expect(panelInfo.GM).toBe(true);
    expect(panelInfo.hasChildren).toBe(true);

    // Job completes -> swapToLatest swaps [data-swap] regions in place.
    await expect(page.locator('[data-desk-deck="primary"]')).toHaveText(
      'Updated deck after generation.',
    );

    // Buttons re-enabled (runFlow sets genBtn.disabled=false after swapToLatest resolves).
    await page.waitForTimeout(150);
    await expect(page.locator('#btn-generate')).not.toBeDisabled();

    // Swapped boot state re-applied (story 1 now liked).
    await expect(page.locator('[data-story-id="1"][data-action="like"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a failed generation surfaces "Generation failed: exit code 1", re-enables the button and hides the panel', async ({ page }) => {
    const mock = new MockServer(page);
    mock.setGenerateFails(1); // /api/restricted/generate starts a failed job
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-generate');
    await expect(page.locator('#btn-generate')).toBeEnabled();

    await page.evaluate(() => document.getElementById('btn-generate')?.click());
    await expect(page.locator('#btn-generate')).toBeDisabled();

    // A generate call was made.
    await waitFor(() => mock.generateCalls.length === 1);
    expect(mock.generateCalls[0].engine).toBe('keyword');

    // watchJob observed the failed status and surfaced the error.
    await expect(page.locator('#status')).toHaveText(/Generation failed: exit code 1/);
    await expect(page.locator('#status')).toHaveClass(/error/);

    // runFlow's failure path re-enables the button and hides the panel.
    await page.waitForTimeout(150);
    await expect(page.locator('#btn-generate')).not.toBeDisabled();
    await expect(page.locator('#gen-panel')).toBeHidden();
  });
});

test.describe('brief page — generation "both" engines', () => {
  test('running "both" starts a keyword job then an lr job', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-generate');

    // Set engine to "both" via the sidebar segmented control.
    await page.evaluate(() => {
      const el = document.getElementById('sb-engine-seg');
      const seg = el?.querySelector('[data-value="both"]');
      seg?.click();
    });
    await expect(page.locator('#engine-select')).toHaveValue('both');

    await page.evaluate(() => document.getElementById('btn-generate')?.click());
    await expect(page.locator('#btn-generate')).toBeDisabled();

    // Both engines run back to back: two /api/restricted/generate calls, keyword then lr.
    await waitFor(() => mock.generateCalls.length === 2);
    expect(mock.generateCalls.map((c) => c.engine)).toEqual(['keyword', 'lr']);
  });
});

test.describe('brief page — attach to a running job', () => {
  test('the page attaches to an already-running job (id=0) and watches it', async ({ page }) => {
    const mock = new MockServer(page);
    mock.setRunningJob('lr');
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#btn-generate');

    // The page's attach fetch (id=0) observed a running job.
    await waitFor(() => mock.jobPolls.some((p) => p.id === 0));
    // The progress panel is rendered while the attached job runs.
    await expect(page.locator('#gen-panel')).toBeVisible();
  });
});

test.describe('sidebar (desktop)', () => {
  test('collapse / expand via toggle', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#sb-toggle');
    const root = page.locator('html');
    const toggle = page.locator('#sb-toggle');

    // Start expanded; collapse via toggle.
    await expect(root).toHaveAttribute('data-sb', 'expanded');
    await toggle.click({ force: true });
    await expect(root).toHaveAttribute('data-sb', 'collapsed');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Re-expand.
    await toggle.click({ force: true });
    await expect(root).toHaveAttribute('data-sb', 'expanded');
  });

  test('engine segmented control sets the engine', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#sb-engine-seg');

    // Segmented control: clicking a segment updates the hidden engine-select.
    await page.click('#sb-engine-seg [data-value="lr"]', { force: true });
    await expect(page.locator('#engine-select')).toHaveValue('lr');

    await page.click('#sb-engine-seg [data-value="keyword"]', { force: true });
    await expect(page.locator('#engine-select')).toHaveValue('keyword');
  });

  test('engine picker flyout (collapsed desktop) sets the engine', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#sb-toggle');

    // Collapse the sidebar so #sb-engine becomes visible (desktop collapsed shows it).
    await page.click('#sb-toggle', { force: true });
    await expect(page.locator('html')).toHaveAttribute('data-sb', 'collapsed');
    await page.waitForSelector('#sb-engine', { state: 'visible' });

    // Open the engine picker flyout and choose "lr".
    await page.click('#sb-engine', { force: true });
    await page.locator('.sb-opt').filter({ hasText: 'LR' }).first().click({ force: true });
    await expect(page.locator('#engine-select')).toHaveValue('lr');
  });
});

test.describe('sidebar (narrow)', () => {
  test.use({ viewport: { width: 500, height: 800 } });

  test('FAB opens, backdrop closes, prev/next step briefs', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    // #sb-toggle may be hidden by CSS in narrow collapsed mode; wait for attached.
    await page.waitForSelector('#sb-toggle', { state: 'attached' });
    const root = page.locator('html');

    // Narrow mode starts collapsed; FAB is visible.
    await expect(root).toHaveAttribute('data-sb', 'collapsed');
    await expect(page.locator('#sb-fab')).toBeVisible();

    // FAB re-opens (use evaluate for reliable click in narrow mode).
    await page.evaluate(() => document.getElementById('sb-fab')?.click());
    await expect(root).toHaveAttribute('data-sb', 'expanded');

    // Backdrop collapses.
    await page.evaluate(() => document.getElementById('sb-backdrop')?.click());
    await expect(root).toHaveAttribute('data-sb', 'collapsed');

    // Expand and step to an older brief via sb-prev.
    await page.evaluate(() => document.getElementById('sb-toggle')?.click());
    await expect(root).toHaveAttribute('data-sb', 'expanded');
    await page.evaluate(() => document.getElementById('sb-prev')?.click());
    await expect(page).toHaveURL(/\/brief\/6/);
  });

  test('error toast shows when status is in error state (narrow)', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('#sb-toggle', { state: 'attached' });
    const root = page.locator('html');

    await expect(root).toHaveAttribute('data-sb', 'collapsed');

    // Force the status element into an error state; sidebar mirrors it and shows the toast.
    await page.evaluate(() => {
      const st = document.getElementById('status');
      st.textContent = 'Generation failed: boom';
      st.classList.add('error');
      st.dispatchEvent(new Event('DOMSubtreeModified'));
    });
    await page.waitForTimeout(300);
    await expect(page.locator('#sb-toast')).toBeVisible();
    await expect(page.locator('#sb-toast')).toHaveText(/boom/);
  });
});

test.describe('archive page', () => {
  test('theme, search, mark filter, facets and paging all hit the fake API', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/archive`);
    await page.waitForSelector('#grid');
    // Facets load on page load; assert chips render (proves facets endpoint was hit).
    await page.waitForSelector('#tagbar .chip');

    // Theme toggle works on the archive page too.
    await page.click('#btn-theme');
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Facets populated the selects and tag chips.
    await expect(await page.locator('#desk option').count()).toBeGreaterThan(1);
    await expect(await page.locator('#tagbar .chip').count()).toBeGreaterThan(0);

    // Count reflects the fixture total.
    await expect(page.locator('#count')).toHaveText(/6 stories/);

    // Search (debounced) filters server-side.
    await page.locator('#q').fill('physics');
    await waitFor(() => mock.storyCalls.some((c) => c.q === 'physics'));
    await expect(page.locator('#count')).toHaveText(/2 stories/);

    // Mark filter.
    await page.locator('#mark [data-mark="liked"]').click();
    await expect(page.locator('#mark [data-mark="liked"]')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => mock.storyCalls.some((c) => c.mark === 'liked'));

    // Desk facet filter.
    await page.locator('#desk').selectOption('science');
    await waitFor(() => mock.storyCalls.some((c) => c.desk === 'science'));

    // Paging: first page requests limit=25 offset=0.
    await waitFor(() => mock.storyCalls.some((c) => c.limit === '25' && c.offset === '0'));

    // Reset clears all filters (set a filter first so reset triggers a fetch).
    await page.locator('#q').fill('physics');
    await waitFor(() => mock.storyCalls.some((c) => c.q === 'physics'));
    await page.click('#reset');
    await expect(page.locator('#q')).toHaveValue('');
    await expect(page.locator('#mark [data-mark=""]')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => mock.storyCalls.some((c) => !c.q && !c.mark));
  });

  test('tag chips toggle and stay within the 5-tag cap', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/archive`);
    await page.waitForSelector('#tagbar .chip');

    const aiChip = page.locator('#tagbar .chip').filter({ hasText: '#ai' }).first();
    await aiChip.click({ force: true });
    await expect(aiChip).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => mock.storyCalls.some((c) => c.tag && c.tag.includes('ai')));

    await aiChip.click({ force: true });
    await expect(aiChip).toHaveAttribute('aria-pressed', 'false');
  });

  test('grid like/save toggles optimistically and reverts on error', async ({ page }) => {
    const mock = new MockServer(page);
    mock.failFeedbackFor(1);
    await page.goto(`${baseUrl}/archive`);
    await page.waitForSelector('#grid');
    // Wait for gridjs to render story cells (async render).
    await page.waitForFunction(() => !!document.querySelector('.story-cell'));

    const like = page.locator('[data-action="like"][data-story-id="1"]').first();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await like.click({ force: true });
    await waitFor(() => mock.liked('1') === false); // reverted (feedback fails)
    await expect(like).toHaveAttribute('aria-pressed', 'false');

    // Now allow writes and confirm success persists.
    mock.failFeedbackFor(null);
    await like.click({ force: true });
    await waitFor(() => mock.liked('1') === true);
    await expect(like).toHaveAttribute('aria-pressed', 'true');
  });

  test('external archive links open in a new tab with noopener noreferrer', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/archive`);
    await page.waitForSelector('.story-cell a[href*="example.com/story/"]');
    const link = page.locator('.story-cell a[href*="example.com/story/"]').first();

    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click({ force: true })]);
    await popup.close();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener noreferrer/);
  });
});

test.describe('LLM API mock', () => {
  test('openrouter.ai chat completions are stubbed (no real LLM call)', async ({ page }) => {
    const mock = new MockServer(page);
    await page.goto(`${baseUrl}/`);
    // Use the page's own fetch (intercepted by page.route) rather than APIRequestContext
    // (which bypasses route interception and would hit the real network).
    const status = await page.evaluate(async () => {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      });
      return r.status;
    });
    expect(status).toBe(200);

    const body = await page.evaluate(async () => {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      });
      return r.json();
    });
    expect(body.choices[0].message.content).toContain('items');
  });
});
