/** Daily brief orchestrator (port of src/brief.js).

fetch -> classify -> upsert -> select -> LLM edit -> append to DB.
Entry point: main(flags) -> exit code.
*/
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { connect, tx, loadPool, loadLikedIds, upsertPool, deletePool, prunePool,
  sameDayCounts, appendBrief } from './db.js';
import { pickDesk, pickReserves, kindOf, DEFAULTS as SELECTION_DEFAULTS } from './selection.js';
import { LLM, LLMUnavailable, buildUserMessageMulti, applyEditorMulti, applyEditor, setDebugLog } from './agent.js';
import { RunLog } from './runlog.js';
import { Progress } from './progress.js';
import { log, warn, setLogFile, LOG_FILE } from './util.js';
import { fetchAll, refreshApiFeeds, setCacheResolver } from './fetch/fetcher.js';
import './fetch/semanticscholar.js'; // side-effect: registers S2 API fetcher

// Ranker (LR engine) imports — called in-process instead of spawning node ranker/cli.js
import { Store as RankerStore } from '../../ranker/store.js';
import { ensureEmbeddings, ensureFitted, prepareCandidates } from '../../ranker/pipeline.js';
import { mulberry32, selectBrief as rankerSelectBrief } from '../../ranker/sampler.js';
import { makeBackside, poolCountsByCluster } from '../../ranker/backside.js';
import { fromBlob } from '../../ranker/vec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..', '..');
export const CACHE = join(homedir(), '.cache', 'daily_brief');
setCacheResolver(() => CACHE);

function loadJson(file, def = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return def; }
}

function dbPath(cfg) {
  return join(PROJECT_ROOT, cfg.db_file ?? 'daily_brief.db');
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function ageDays(item, now) {
  const d = parseDate(item.published) || parseDate(item.first_seen) || now;
  return Math.max(0, (now - d) / 86400000);
}

function ageOrNone(value, now) {
  const d = parseDate(value);
  return d === null ? null : Math.round(Math.max(0, (now - d) / 86400000) * 100) / 100;
}

function itemView(item, now) {
  return {
    id: item.id, title: item.title, authors: item.authors,
    mode: item.mode, p: item.p, V: item.V,
    cluster: item.cluster, core: item.core, kind: item.kind,
    published_age_days: ageOrNone(item.published, now),
    first_seen_age_days: ageOrNone(item.first_seen, now),
  };
}

// --------------------------------------------------------------------------- classify

const _TERM_CACHE = {};

function termRegex(term) {
  let p = _TERM_CACHE[term];
  if (!p) {
    const body = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    p = new RegExp(`(?<![a-z0-9])${body}${term.length <= 4 ? '(?![a-z0-9])' : ''}`, 'i');
    _TERM_CACHE[term] = p;
  }
  return p;
}

export function classify(item, keywords, subtopicToDesk) {
  const title = String(item.title ?? '').toLowerCase();
  const body = String(item.snippet ?? '').toLowerCase();
  const scores = {};
  for (const [sub, terms] of Object.entries(keywords)) {
    let h = 0;
    for (const t of terms) {
      if (termRegex(t).test(title)) h += 2;
      else if (termRegex(t).test(body)) h += 1;
    }
    if (h) scores[sub] = h;
  }
  const hint = item.hint;
  if (hint && hint in keywords) scores[hint] = (scores[hint] ?? 0) + 1.0;
  if (!Object.keys(scores).length) return null;
  const sub = Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b);
  const hits = scores[sub];
  const onlyHint = hint === sub && hits <= 1.0;
  const kw = onlyHint ? 0.3 : Math.min(1.0, hits / 4);
  if (!hint && hits < 2) return null;
  item.subtopic = sub;
  item.desk = subtopicToDesk[sub];
  item.rel = Math.round(Math.max(0.05, Math.min(1.0, item.weight * (0.3 + 0.7 * kw))) * 10000) / 10000;
  return item;
}

// --------------------------------------------------------------------------- LR selection (in-process, replaces spawning node ranker/cli.js)

export async function selectLr(dateKey, seed, cfg, src, pool, now, run) {
  const rankerCfg = cfg.ranker ?? {};
  const store = new RankerStore(dbPath(cfg));
  try {
    await ensureEmbeddings(store, rankerCfg, { persist: true });
    const fitted = await ensureFitted(store, rankerCfg, { persist: true, run, cutoffDate: dateKey });
    if (!fitted.interests) throw new Error('interests not built');

    const nowSelect = new Date(`${dateKey}T12:00:00.000Z`);
    const candidates = prepareCandidates(store, rankerCfg, fitted, dateKey, nowSelect, run);

    const rng = mulberry32(seed ?? Date.now());
    const out = rankerSelectBrief(candidates, rankerCfg.sampling ?? {}, rng);

    const embRows = new Map((store.getAllEmbeddings() ?? []).map(e => [e.item_id, e]));
    const vecOf = (id) => {
      const e = embRows.get(id);
      if (!e || !e.vec) return null;
      return e.vec instanceof Float32Array ? e.vec : fromBlob(e.vec);
    };
    for (const cl of fitted.interests.clusters) {
      if (!(cl.vec instanceof Float32Array)) {
        const e = embRows.get(cl.medoid);
        cl.vec = e && e.vec ? (e.vec instanceof Float32Array ? e.vec : fromBlob(e.vec)) : null;
      }
    }
    const backside = makeBackside(fitted.interests, vecOf, poolCountsByCluster(candidates));

    const result = {};
    for (const [desk, items] of Object.entries(out)) {
      result[desk] = items.map(c => ({
        id: c.id, mode: c.mode, p: c.p, V: c.V, cluster: c.cluster, core: c.core,
        ...backside(c),
      }));
    }

    const poolById = new Map(pool.map(p => [p.id, p]));
    const resultDict = {};
    for (const [desk, items] of Object.entries(result)) {
      const merged = [];
      for (const rankerItem of items) {
        const poolItem = poolById.get(rankerItem.id);
        if (!poolItem) {
          log(`[lr] WARNING: selected item ${rankerItem.id} not in pool, skipping`);
          continue;
        }
        const mergedItem = { ...poolItem };
        mergedItem.mode = rankerItem.mode;
        mergedItem.p = rankerItem.p;
        mergedItem.V = rankerItem.V;
        mergedItem.cluster = rankerItem.cluster;
        mergedItem.core = rankerItem.core;
        for (const k of ['cos_dist', 'cluster_size', 'cluster_pool', 'medoid_id']) {
          mergedItem[k] = rankerItem[k] ?? null;
        }
        mergedItem.age_days = ageDays(mergedItem, now);
        mergedItem.kind = kindOf(mergedItem, { ...SELECTION_DEFAULTS, ...(cfg.selection ?? {}) });
        merged.push(mergedItem);
      }
      resultDict[desk] = merged;
    }
    return resultDict;
  } finally {
    store.close();
  }
}

// Seeded RNG (mulberry32) returning 0-1
function makeRng(s) {
  let a = s ?? Date.now();
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------------- main

export async function main(flags = {}) {
  const {
    noLlm = false, noFetch = false, dryRun = false, seed = null,
    engine = null, logFile = null, progressFile = null,
  } = flags;

  if (logFile) setLogFile(logFile);

  const prog = new Progress(progressFile, null);
  const cfg = loadJson(join(PROJECT_ROOT, 'config.json'));
  const src = loadJson(join(PROJECT_ROOT, 'sources.json'));
  const sub2Desk = {};
  for (const [desk, spec] of Object.entries(src.desks ?? {})) {
    for (const s of spec.subtopics ?? []) sub2Desk[s] = desk;
  }

  let conn;
  try {
    conn = connect(dbPath(cfg));
  } catch (e) {
    log(`FAILED: cannot open database: ${e.message}`);
    return 1;
  }

  const maxAge = cfg.pool?.max_age_days ?? 120;

  // --- background API refresh mode ---
  if (flags.refreshApiFeeds) {
    try {
      const items = await refreshApiFeeds(cfg, src);
      const classified = [];
      for (const it of items) {
        const c = classify(it, src.keywords ?? {}, sub2Desk);
        if (c) classified.push(c);
      }
      const now = new Date();
      tx(conn, () => {
        upsertPool(conn, classified, now);
        prunePool(conn, now, maxAge);
        log(`[refresh-api] upserted ${classified.length} items, pruned to max_age ${maxAge}d`);
      });
      log('API background refresh complete');
    } catch (e) {
      warn(`API refresh failed: ${e.constructor.name}: ${e.message}`);
    }
    conn.close();
    return 0;
  }

  const scfg = { ...SELECTION_DEFAULTS, ...(cfg.selection ?? {}) };
  const seededRng = makeRng(seed ?? Date.now());
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const run = new RunLog(PROJECT_ROOT, 'brief', { date: dateKey, seed, argv: process.argv.slice(2) });

  // --- fetch + classify + upsert ---
  if (noFetch) {
    log('skipping fetch; using persisted pool');
  } else {
    const raw = await fetchAll(cfg, src, true);
    const seen = {};
    const dropped = new Set();
    for (const it of raw) {
      const c = classify(it, src.keywords ?? {}, sub2Desk);
      if (!c) { dropped.add(it.id); continue; }
      if (!seen[c.id] || c.rel > seen[c.id].rel) seen[c.id] = c;
    }
    const classified = Object.values(seen);
    tx(conn, () => {
      const added = upsertPool(conn, classified, now);
      deletePool(conn, [...dropped].filter(id => !seen[id]));
      prunePool(conn, now, maxAge);
      log(`classified ${classified.length}/${raw.length} items, ${added} new in pool`);
    });
  }

  let pool = loadPool(conn);
  if (!pool.length) {
    log('pool is empty (all sources failed?)');
    conn.close();
    run.close();
    return 1;
  }

  // Same-day rerun adjustment (in memory only)
  const [sdShown, sdRej] = sameDayCounts(conn, dateKey);
  for (const p of pool) {
    p.times_shown = Math.max(0, p.times_shown - (sdShown[p.id] ?? 0));
    p.rejected = Math.max(0, p.rejected - (sdRej[p.id] ?? 0));
    p.age_days = ageDays(p, now);
  }

  // Exclude liked/saved
  const maxLikedDays = (cfg.ranker?.interests ?? {}).maxLikedDays;
  let cutoffDate = null;
  if (maxLikedDays && maxLikedDays > 0) {
    cutoffDate = new Date(Date.now() - maxLikedDays * 86400000).toISOString().slice(0, 10);
  }
  const likedIds = loadLikedIds(conn, cutoffDate);
  pool = pool.filter(p => !likedIds.has(p.id));
  if (likedIds.size) log(`excluded ${likedIds.size} liked/saved items from pool`);

  prog.phase('selecting');

  // --- selection ---
  const nStories = cfg.stories_per_desk ?? 5;
  const kReserve = cfg.reserve_per_desk ?? 25;
  const selected = {};
  const eng = engine ?? cfg.ranker?.engine ?? 'keyword';
  log(`selection engine: ${eng}`);
  run.event('engine', { engine: eng, pool: pool.length, n: nStories, reserve: kReserve });

  if (eng === 'lr') {
    try {
      const selResult = await selectLr(dateKey, seed, cfg, src, pool, now, run);
      for (const [desk, items] of Object.entries(selResult)) {
        const picks = items.filter(i => i.mode !== 'reserve');
        const reserves = items.filter(i => i.mode === 'reserve');
        const explore = picks.filter(i => i.mode === 'explore').length;
        log(`${desk}: ${picks.length} picked (${explore} explore) + ${reserves.length} reserve`);
      }
      Object.assign(selected, selResult);
    } catch (e) {
      warn(`LR selection failed: ${e.message}. Falling back to keyword engine.`);
      run.event('engine_fallback', { error: e.message });
    }
  }

  if (!Object.keys(selected).length) {
    for (const [desk, spec] of Object.entries(src.desks ?? {})) {
      const candsAll = pool.filter(p => spec.subtopics.includes(p.subtopic));
      const picks = pickDesk(candsAll, spec.subtopics, nStories, scfg, seededRng,
        { newslike: 1, paperlike: 2 });
      const chosen = picks.map(([i, m]) => ({ ...i, mode: m }));
      const reserve = pickReserves(
        candsAll,
        new Set(chosen.map(c => c.id)),
        kReserve, scfg, { newslike: 1 },
      ).map(i => ({ ...i, mode: 'reserve' }));
      selected[desk] = [...chosen, ...reserve];
      for (const c of selected[desk]) c.kind = kindOf(c, scfg);
      log(`${desk}: ${chosen.length} picked + ${reserve.length} reserve`);
    }
  }

  prog.setEngine(Object.keys(selected).length ? eng : 'keyword');

  for (const [desk, items] of Object.entries(selected)) {
    run.event('selection', {
      desk, picks: items.filter(i => i.mode !== 'reserve').map(i => itemView(i, now)),
      reserves: items.filter(i => i.mode === 'reserve').map(i => itemView(i, now)),
    });
  }

  // --- LLM edit ---
  let llm = null;
  if (!noLlm) {
    try {
      llm = new LLM(cfg.llm ?? {});
      const rem = await llm.remainingDaily();
      if (rem !== null && rem < (cfg.llm?.min_remaining_daily ?? 3)) {
        throw new LLMUnavailable(`only ${rem} free requests left today`);
      }
    } catch (e) {
      warn(`LLM skipped: ${e.message}. Showing unedited edition.`);
      llm = null;
    }
  }

  const debugDir = join(PROJECT_ROOT, cfg.debug_dir ?? 'logs');
  mkdirSync(debugDir, { recursive: true });
  setDebugLog(join(debugDir, 'agent_responses.jsonl'));

  const todayS = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const system = readFileSync(join(PROJECT_ROOT, 'prompt_system.md'), 'utf8');
  const maxCap = Number(cfg.max_agent_output_items_per_desk ?? nStories);
  const systemFilled = system.replace('{{max_agent_output_items_per_desk}}', String(maxCap));

  const candsByDesk = {};
  for (const [desk, spec] of Object.entries(src.desks ?? {})) {
    candsByDesk[desk] = eng === 'lr'
      ? (selected[desk] ?? []).filter(c => c.mode !== 'reserve')
      : (selected[desk] ?? []);
  }

  const deskSpecs = Object.entries(src.desks ?? {}).map(([key, spec]) => ({ key, title: spec.title }));

  for (const [desk, spec] of Object.entries(src.desks ?? {})) {
    prog.deskInit(desk, spec.title, nStories);
    if (eng === 'lr') prog.deskRaw(desk, candsByDesk[desk] ?? []);
  }
  prog.phase('editing');

  let result = null;
  if (llm) {
    try {
      result = await llm.chat(systemFilled, buildUserMessageMulti(deskSpecs, nStories, candsByDesk, todayS, maxCap));
    } catch (e) {
      warn(`editor unavailable (${e.message}); showing raw items on all desks`);
      if (e.message.includes('cap') || e.message.includes('HTTP 401')) llm = null;
    }
  }

  const split = result ? applyEditorMulti(selected, result, nStories) : null;
  const desksOut = {};
  const allRejected = [];
  for (const [desk, spec] of Object.entries(src.desks ?? {})) {
    prog.deskWorking(desk, true);
    let stories, rejected, deck;
    if (split) {
      [stories, rejected, deck] = split[desk];
    } else {
      [stories, rejected, deck] = applyEditor(selected[desk] ?? [], null, nStories);
    }
    prog.deskEdited(desk, stories, deck);
    run.event('editor', {
      desk, llm_answered: result !== null,
      input: (candsByDesk[desk] ?? []).map(c => itemView(c, now)),
      output: stories.map(s => ({ ...itemView(s, now), summarized: s.summarized })),
      rejected, reserves_used: stories.filter(s => s.mode === 'reserve').map(s => s.id), deck,
    });
    desksOut[desk] = { title: spec.title, stories, deck: deck || 'Unedited candidates, ranked by relevance and freshness.' };
    allRejected.push(...rejected);
  }

  // --- persist ---
  const allStories = Object.values(desksOut).flatMap(d => d.stories);
  run.event('final', { stories: allStories.map(s => itemView(s, now)) });
  const models = llm && llm.models ? [...new Set(llm.models)] : [];
  const meta = {
    model: models.length ? models.join(', ') : 'no model (raw items)',
    engine: eng,
    n_fresh: allStories.filter(s => s.kind === 'fresh').length,
    n_archive: allStories.filter(s => s.kind === 'archive').length,
    n_explore: allStories.filter(s => s.mode === 'explore').length,
    epsilon: scfg.epsilon, pool: pool.length,
    sources: [...new Set(allStories.map(s => s.source.split(':')[0]))].sort().join(', '),
  };
  const llmRequests = llm ? llm.requests : 0;

  if (dryRun) {
    log(`DRY-RUN ${allStories.length} stories, model=${meta.model}, llm_requests=${llmRequests}`);
    conn.close();
    run.close();
    return 0;
  }

  prog.phase('committing');
  const briefId = tx(conn, () => appendBrief(conn, {
    dateKey, now, model: meta.model, llmRequests, rejectedIds: allRejected, desksOut, meta,
  }));
  log(`brief generation done: brief_id=${briefId} (${allStories.length} stories, model=${meta.model}, llm_requests=${llmRequests})`);
  prog.phase('done');
  log(`OK brief_id=${briefId} (${allStories.length} stories, model=${meta.model}, llm_requests=${llmRequests})`);
  conn.close();
  run.close();
  return 0;
}

export { main as default };
