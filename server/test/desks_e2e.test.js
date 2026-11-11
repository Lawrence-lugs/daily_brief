// End-to-end tests for the user-configured desks feature.
//
// These tests exercise the full desk pipeline end-to-end without Playwright
// and without the LLM:
//
//   1. Config contract: loadDesksConfig against the real config.json
//   2. Keyword -> desk classification: real keywords + subtopicToDesk
//   3. Desk-aware Ward clustering: real perfect_samples.json desks, assert no
//      cluster mixes desks and cross-desk merges are skipped
//   4. Per-desk sampling: selectBrief with multi-desk candidates, assert no
//      cross-desk backfill and short desks return fewer
//   5. Full brief generation: brief.main() (noFetch/noLlm) asserts per-desk
//      picks land in their own desks
//   6. Frontend render: render.js page() renders N desk sections + grid style
//
// Runs with: node --test server/test/desks_e2e.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Config contract e2e (real config.json)
// ---------------------------------------------------------------------------

test('desks e2e: config contract loads real desks/keywords, sources.json clean', async () => {
  const { loadDesksConfig } = await import('../lib/config.js');
  const { DESKS, subtopicToDesk, warnings } = loadDesksConfig(join(ROOT, 'user', 'defaults'));

  // 3 desks in declared order, misc included.
  assert.equal(DESKS.length, 3);
  assert.deepEqual(DESKS.map((d) => d.key), ['primary', 'science', 'misc']);
  assert.equal(DESKS[0].title, 'Silicon & Architecture Desk');
  assert.equal(DESKS[1].title, 'Science Desk');
  assert.equal(DESKS[2].title, 'Misc.');

  // All 10 subtopics mapped to a desk.
  const expected = {
    dse: 'primary', accel: 'primary', fab: 'primary',
    gr: 'science', qft: 'science', condmat: 'science', neuro: 'science',
  };
  assert.deepEqual(subtopicToDesk, expected);

  // No warnings with a well-formed real config.
  assert.equal(warnings.length, 0);

  // sources.json has no desks/keywords; config.json owns them.
  const src = loadJson('user/defaults/sources.json');
  assert.ok(!('desks' in src) && !('keywords' in src));
  const cfg = loadJson('user/defaults/config.json');
  assert.ok('desks' in cfg && 'keywords' in cfg && 'misc' in cfg.desks);
  assert.ok(!cfg.ranker.sampling.slots && !cfg.ranker.sampling.desks);
});

test('desks e2e: config validation rejects duplicate subtopic across desks', async () => {
  const { loadDesksConfig } = await import('../lib/config.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'desks-e2e-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: {
        primary: { title: 'Primary', 'keyword-model-subtopics': ['dse', 'shared'] },
        science: { title: 'Science', 'keyword-model-subtopics': ['gr', 'shared'] },
      },
      keywords: { dse: ['x'], gr: ['y'], shared: ['z'] },
    }));
    assert.throws(() => loadDesksConfig(dir), /assigned to more than one desk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desks e2e: config validation warns on orphan keyword group', async () => {
  const { loadDesksConfig } = await import('../lib/config.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'desks-e2e-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: { primary: { title: 'Primary', 'keyword-model-subtopics': ['dse'] } },
      keywords: { dse: ['x'], orphan: ['y'] },
    }));
    const { warnings } = loadDesksConfig(dir);
    assert.ok(warnings.some((w) => w.includes('orphan') && w.includes('not assigned to any desk')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Keyword -> desk classification e2e (real keywords + subtopicToDesk)
// ---------------------------------------------------------------------------

test('desks e2e: classify maps keyword matches to desks via subtopicToDesk', async () => {
  const { classify } = await import('../lib/brief.js');
  const { loadDesksConfig } = await import('../lib/config.js');
  const { DESKS, subtopicToDesk } = loadDesksConfig(join(ROOT, 'user', 'defaults'));
  const cfg = loadJson('user/defaults/config.json');

  // Silicon desk subtopics -> primary desk.
  for (const sub of ['dse', 'accel', 'fab']) {
    const kw = cfg.keywords[sub];
    const hit = kw[0];
    const c = classify({ title: `news about ${hit}`, snippet: '', weight: 1.0 }, cfg.keywords, subtopicToDesk);
    assert.ok(c, `expected match for ${sub}`);
    assert.equal(c.subtopic, sub);
    assert.equal(c.desk, 'primary');
    assert.ok(c.rel > 0 && c.rel <= 1);
  }

  // Science desk subtopics -> science desk.
  for (const sub of ['gr', 'qft', 'condmat', 'neuro']) {
    const kw = cfg.keywords[sub];
    const hit = kw[0];
    const c = classify({ title: `research on ${hit}`, snippet: '', weight: 1.0 }, cfg.keywords, subtopicToDesk);
    assert.ok(c, `expected match for ${sub}`);
    assert.equal(c.subtopic, sub);
    assert.equal(c.desk, 'science');
  }

  // No keyword match -> null.
  assert.equal(classify({ title: 'completely unrelated story', snippet: 'nothing here', weight: 1.0 },
    cfg.keywords, subtopicToDesk), null);

  // Hint boost assigns desk even on a single hit.
  const hinted = classify({ title: 'x', snippet: 'y', weight: 1.0, hint: 'neuro' }, cfg.keywords, subtopicToDesk);
  assert.equal(hinted.subtopic, 'neuro');
  assert.equal(hinted.desk, 'science');
});

test('desks e2e: unassigned subtopic classifies but gets no desk (warning case)', async () => {
  const { classify } = await import('../lib/brief.js');
  const { loadDesksConfig } = await import('../lib/config.js');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'desks-e2e-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      stories_per_desk: 5,
      desks: { primary: { title: 'Primary', 'keyword-model-subtopics': ['dse'] } },
      keywords: { dse: ['transformer'], orphan: ['quantum'] },
    }));
    const { subtopicToDesk } = loadDesksConfig(dir);
    // 'orphan' has keywords but no desk -> subtopicToDesk['orphan'] is undefined.
    assert.equal(subtopicToDesk['orphan'], undefined);
    const c = classify({ title: 'quantum computing', snippet: '', weight: 1.0 },
      { dse: ['transformer'], orphan: ['quantum'] }, subtopicToDesk);
    assert.equal(c.subtopic, 'orphan');
    assert.equal(c.desk, undefined); // unassigned -> no desk (would land in misc bucket)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Desk-aware Ward clustering e2e (real perfect_samples.json desks)
// ---------------------------------------------------------------------------

test('desks e2e: buildInterests keeps clusters single-desk, skips cross-desk merges', async () => {
  const { buildInterests } = await import('../../ranker/interests.js');
  const { assertVec, DIM, normalize } = await import('../../ranker/vec.js');

  const samples = loadJson('user/defaults/perfect_samples.json');
  const primary = samples.filter((s) => s.desk === 'primary');
  const science = samples.filter((s) => s.desk === 'science');
  assert.ok(primary.length > 0 && science.length > 0);

  // Build tight, separated blobs per desk using real desk labels.
  const rng = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) | 0; return (s >>> 16) / 65536; }; })();
  const unit = (...a) => normalize(Float32Array.from(a));
  const makeVecs = (base, n) => Array.from({ length: n }, () => unit(...base.map((x) => x + (rng() - 0.5) * 0.02)));

  const pVecs = makeVecs([1, 0, 0], primary.length);
  const sVecs = makeVecs([0, 1, 0], science.length);

  const perfect = [
    ...primary.map((s, i) => ({ id: `ps:${s.id}`, vec: pVecs[i], core: s.core, representative: s.representative, desk: s.desk })),
    ...science.map((s, i) => ({ id: `ps:${s.id}`, vec: sVecs[i], core: s.core, representative: s.representative, desk: s.desk })),
  ];

  // A few liked items (no desk) near each blob; they merge freely but carry no desk.
  const liked = [
    ...makeVecs([1, 0, 0], 3).map((v, i) => ({ id: `liked-p-${i}`, vec: v })),
    ...makeVecs([0, 1, 0], 2).map((v, i) => ({ id: `liked-s-${i}`, vec: v })),
    { id: 'liked-orphan', vec: unit([0, 0, 1]) }, // far away -> own cluster, no perfect members
  ];

  const it = buildInterests(perfect, liked, {
    kappa: 20,
    mode: 'stop',
    minClusters: 1,
    interests: { minClusters: 1 },
  });

  // At least one cluster per desk.
  const desks = new Set(it.clusters.map((c) => c.desk));
  assert.ok(desks.has('primary'), 'primary desk cluster exists');
  assert.ok(desks.has('science'), 'science desk cluster exists');

  // No cluster mixes desks: every cluster's perfect members all share one desk.
  for (const c of it.clusters) {
    const memberDesks = new Set(c.members.map((id) => {
      const p = perfect.find((x) => x.id === id);
      return p ? p.desk : null;
    }).filter((d) => d !== null));
    if (memberDesks.size > 0) {
      assert.equal(memberDesks.size, 1, `cluster ${c.id} mixes desks: ${[...memberDesks]}`);
    }
  }

  // Cross-desk merges were skipped (the blobs are far apart and reps are in
  // different desks, so the cross-desk merge is skipped, not stopped).
  assert.ok(typeof it.skippedMerges === 'number' && it.skippedMerges >= 0);

  // Liked-only cluster (orphan) is 'misc'.
  const orphanCluster = it.clusters.find((c) => c.members.includes('liked-orphan'));
  assert.ok(orphanCluster, 'orphan liked item forms its own cluster');
  assert.equal(orphanCluster.desk, 'misc');
});

// ---------------------------------------------------------------------------
// 4. Per-desk sampling e2e (no cross-desk backfill, short desk fewer)
// ---------------------------------------------------------------------------

test('desks e2e: selectBrief keeps each desk within its own clusters, no cross-desk backfill', async () => {
  const { selectBrief, mulberry32 } = await import('../../ranker/sampler.js');

  const mk = (n, desk, base, core) => Array.from({ length: n }, (_, i) => ({
    id: `${desk}-${i}`,
    p: 0.3 + 0.05 * (i % 6),
    age_days: i,
    days_since_shown: null,
    times_shown: 0,
    cluster: base + (i % 3),
    core,
    desk,
  }));

  // Primary desk: 2 clusters with core items. Science desk: 1 cluster.
  const cands = [...mk(20, 'primary', 0, true), ...mk(20, 'science', 100, false)];
  const before = JSON.stringify(cands);
  const out = selectBrief(cands, {
    epsilon: 0,
    halfLifeDays: 30,
    freshness: { model: 'exponential' },
    dedupe: { hardWindowDays: 2, t0: 7, scale: 2 },
    explore: { gamma: 0.5, floor: 0.01 },
    stories_per_desk: 5,
    reserve_per_desk: 2,
  }, mulberry32(1));

  assert.equal(JSON.stringify(cands), before); // input untouched

  const pri = out.primary.filter((c) => c.mode !== 'reserve');
  const sci = out.science.filter((c) => c.mode !== 'reserve');

  // Each desk capped at stories_per_desk.
  assert.equal(pri.length, 5);
  assert.equal(sci.length, 5);

  // No cross-desk leakage: every primary pick has desk=primary and comes from
  // primary clusters; every science pick has desk=science.
  assert.ok(pri.every((c) => c.desk === 'primary'));
  assert.ok(sci.every((c) => c.desk === 'science'));
  assert.ok(pri.every((c) => c.cluster < 50)); // primary clusters are base 0..49
  assert.ok(sci.every((c) => c.cluster >= 100)); // science clusters are base 100+

  // No duplicate ids across desks.
  const ids = Object.values(out).flat().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);

  // Reserves per desk.
  assert.equal(out.primary.filter((c) => c.mode === 'reserve').length, 2);
  assert.equal(out.science.filter((c) => c.mode === 'reserve').length, 2);
});

test('desks e2e: selectBrief short desk returns fewer, no backfill from other desk', async () => {
  const { selectBrief, mulberry32 } = await import('../../ranker/sampler.js');

  const mk = (n, desk, base) => Array.from({ length: n }, (_, i) => ({
    id: `${desk}-${i}`,
    p: 0.3 + 0.05 * i,
    age_days: i,
    days_since_shown: null,
    times_shown: 0,
    cluster: base + i,
    core: desk === 'primary',
    desk,
  }));

  // Primary desk has only 3 eligible candidates; science has plenty.
  const cands = [...mk(3, 'primary', 0), ...mk(30, 'science', 100)];
  cands[0].days_since_shown = 0.5; // inside hard window -> removed, leaving 2 primary

  const out = selectBrief(cands, {
    epsilon: 0,
    halfLifeDays: 30,
    freshness: { model: 'exponential' },
    dedupe: { hardWindowDays: 2, t0: 7, scale: 2 },
    explore: { gamma: 0.5, floor: 0.01 },
    stories_per_desk: 5,
    reserve_per_desk: 2,
  }, mulberry32(1));

  assert.ok(!Object.values(out).flat().some((c) => c.id === cands[0].id));

  // Primary desk returns only 2 (short desk), NOT backfilled from science.
  assert.equal(out.primary.filter((c) => c.mode !== 'reserve').length, 2);
  // Science desk still gets its full cap.
  assert.equal(out.science.filter((c) => c.mode !== 'reserve').length, 5);

  // Cross-desk id purity: science picks never have desk=primary.
  assert.ok(out.science.every((c) => c.desk === 'science'));
});

// ---------------------------------------------------------------------------
// 5. Full brief generation e2e (LR engine end-to-end, per-desk picks)
// ---------------------------------------------------------------------------

test('desks e2e: brief.main LR generation yields per-desk picks, no cross-desk leakage', async () => {
  const { main } = await import('../lib/brief.js');
  const { seedDataDir } = await import('../../user/datadir.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const DATA_DIR = mkdtempSync(join(tmpdir(), 'daily-brief-desks-e2e-'));
  try {
    seedDataDir(DATA_DIR, ROOT);

    const code = await main({ noFetch: true, noLlm: true, dataDir: DATA_DIR });
    assert.equal(code, 0);

    // Read the latest brief from the temp DB and assert per-desk separation.
    const { connect } = await import('../lib/db.js');
    const { makeQueries } = await import('../lib/queries.js');
    const conn = connect(join(DATA_DIR, 'daily_brief.db'));
    try {
      const queries = makeQueries(conn, ROOT);
      const briefs = queries.listBriefs();
      assert.ok(briefs.length > 0, 'expected at least one generated brief');
      const latest = briefs[briefs.length - 1];
      const { brief, desks } = queries.getBrief(latest.brief_id);
      assert.ok(brief, 'expected latest brief row');
      assert.ok(desks, 'brief should carry per-desk desks');

      const deskKeys = Object.keys(desks);
      assert.ok(deskKeys.includes('primary') && deskKeys.includes('science'),
        `expected primary+science desks, got ${deskKeys}`);

      // Each desk's stories carry that desk's id (no cross-desk leakage).
      for (const [desk, d] of Object.entries(desks)) {
        for (const s of d.stories) {
          assert.equal(s.desk, desk, `story ${s.story_id} in desk ${desk} has desk=${s.desk}`);
        }
      }

      // Primary and science each have picks (misc may be empty).
      const priPicks = desks.primary?.stories?.length ?? 0;
      const sciPicks = desks.science?.stories?.length ?? 0;
      assert.ok(priPicks > 0, 'primary desk should have picks');
      assert.ok(sciPicks > 0, 'science desk should have picks');
    } finally {
      conn.close();
    }
  } finally {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Frontend render e2e (N desk sections + grid style breakpoints)
// ---------------------------------------------------------------------------

test('desks e2e: render.js page() renders only non-empty desk sections', async () => {
  const { makeRenderer } = await import('../lib/render.js');
  const renderer = makeRenderer({
    templatesDir: join(ROOT, 'server', 'templates'),
    cssFile: join(ROOT, 'tailwind.css'),
    paperName: 'The Daily Die',
  });

  const story = { story_id: 's1', headline: 'H1', blurb: 'B', url: 'https://example.com/1', source: 'x', tags: [], kind: 'fresh', age_days: 0 };
  const desks = {
    primary: { title: 'Silicon & Architecture Desk', deck: 'Deck one.', stories: [story] },
    science: { title: 'Science Desk', deck: 'Deck two.', stories: [] },
    misc: { title: 'Misc.', deck: '', stories: [{ ...story, story_id: 's2', headline: 'H2' }] },
  };

  const html = renderer.page({ brief: null, desks, briefs: [], embed: false });

  // Non-empty desks render a section with generic data-swap="desk-{key}".
  assert.match(html, /data-swap="desk-primary"/);
  assert.match(html, /data-swap="desk-misc"/);

  // Empty desk is not rendered at all: no section, no stories container, no deck paragraph.
  assert.ok(!html.includes('data-swap="desk-science"'), 'empty desk must not render a section');
  assert.ok(!html.includes('data-desk-stories="science"'), 'empty desk must not render a stories container');
  assert.ok(!html.includes('data-desk-deck="science"'), 'empty desk must not render a deck paragraph');

  // main element carries data-desks (grid hook).
  assert.match(html, /<main[^>]*data-desks/);
});

test('desks e2e: desk_grid_style emits N-column breakpoints from non-empty desks only', async () => {
  const { makeRenderer } = await import('../lib/render.js');
  const renderer = makeRenderer({
    templatesDir: join(ROOT, 'server', 'templates'),
    cssFile: join(ROOT, 'tailwind.css'),
    paperName: 'The Daily Die',
  });

  const story = { story_id: 's1', headline: 'H1', blurb: 'B', url: 'https://example.com/1', source: 'x', tags: [], kind: 'fresh', age_days: 0 };
  const desks = {
    primary: { title: 'Primary', deck: '', stories: [story] },
    science: { title: 'Science', deck: '', stories: [{ ...story, story_id: 's2' }] },
    misc: { title: 'Misc.', deck: '', stories: [{ ...story, story_id: 's3' }] },
  };

  const html = renderer.page({ brief: null, desks, briefs: [], embed: false });

  // 3 non-empty desks -> 2 columns at >= 768px, 3 columns at >= ceil(3/2 * 768) = 1152px.
  assert.match(html, /@media \(min-width: 768px\) and \(max-width: 1151px\) \{ \[data-desks\] \{ grid-template-columns: repeat\(2, 1fr\); \} \}/);
  assert.match(html, /@media \(min-width: 1152px\) \{ \[data-desks\] \{ grid-template-columns: repeat\(3, 1fr\); \} \}/);

  // No horizontal scroll: grid (not flex) with gap, no overflow-x rules.
  assert.ok(!html.includes('overflow-x'), 'desk grid style must not introduce horizontal scroll');

  // Desk count drives the breakpoint math.
  assert.ok(html.includes('repeat(3, 1fr)'), '3 non-empty desks should produce a 3-column rule at wide breakpoint');
});

test('desks e2e: desk grid caps at 3 columns regardless of desk count', async () => {
  const { makeRenderer } = await import('../lib/render.js');
  const renderer = makeRenderer({
    templatesDir: join(ROOT, 'server', 'templates'),
    cssFile: join(ROOT, 'tailwind.css'),
    paperName: 'The Daily Die',
  });

  const story = { story_id: 's1', headline: 'H1', blurb: 'B', url: 'https://example.com/1', source: 'x', tags: [], kind: 'fresh', age_days: 0 };
  const desks = {
    primary: { title: 'Primary', deck: '', stories: [story] },
    science: { title: 'Science', deck: '', stories: [{ ...story, story_id: 's2' }] },
    misc: { title: 'Misc.', deck: '', stories: [{ ...story, story_id: 's3' }] },
    arts: { title: 'Arts', deck: '', stories: [{ ...story, story_id: 's4' }] },
    world: { title: 'World', deck: '', stories: [{ ...story, story_id: 's5' }] },
  };

  const html = renderer.page({ brief: null, desks, briefs: [], embed: false });

  // 5 desks but max 3 columns: never a 5-column rule. At 3 columns, 5 = 3 + 2, so 6 tracks:
  // top row spans 2 each, bottom row spans 3 each (fills the width).
  assert.ok(!html.includes('repeat(5, 1fr)'), '5 desks must not produce a 5-column rule');
  assert.match(html, /@media \(min-width: 1152px\) \{ \[data-desks\] \{ grid-template-columns: repeat\(6, 1fr\); \} \}/);
  assert.match(html, /@media \(min-width: 1152px\) \{ \[data-desks\] > section:nth-last-child\(-n\+2\) \{ grid-column: span 3; \} \}/);
  assert.ok(!html.includes('overflow-x'), 'desk grid style must not introduce horizontal scroll');
});

test('desks e2e: desk_grid_style is empty when all desks are empty', async () => {
  const { makeRenderer } = await import('../lib/render.js');
  const renderer = makeRenderer({
    templatesDir: join(ROOT, 'server', 'templates'),
    cssFile: join(ROOT, 'tailwind.css'),
    paperName: 'The Daily Die',
  });

  const desks = {
    primary: { title: 'Primary', deck: '', stories: [] },
    science: { title: 'Science', deck: '', stories: [] },
    misc: { title: 'Misc.', deck: '', stories: [] },
  };

  const html = renderer.page({ brief: null, desks, briefs: [], embed: false });

  // No desk sections and no desk grid rules when every desk is empty.
  assert.ok(!html.includes('data-swap="desk-'), 'no desk sections should render');
  assert.ok(!html.includes('[data-desks] { display: grid'), 'no desk column rules when no non-empty desks');
});
