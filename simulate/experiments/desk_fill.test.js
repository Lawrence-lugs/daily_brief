import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDeskFill } from './desk_fill.js';

test('arbitrary desk and feed, delayed arrival, cutoff drought and review round trip', t => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-fill-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const config = join(dir, 'custom.json');
  const db = join(dir,'future.sqlite');
  const conn = new DatabaseSync(db);
  conn.exec(readFileSync(new URL('../../schema.sql',import.meta.url),'utf8'));
  writeFileSync(config,JSON.stringify({ desks:{ optics:{ subtopics:['light'] } }, stories_per_desk:1 }));
  writeFileSync(join(dir,'sources.json'),JSON.stringify({ feeds:{ rss:[{ name:'Photon Monthly', cadence_days:30 }] } }));
  const opts = { db, config, spec:{ seeds:[7], windows:1, windowDays:2, droughtDays:1 } };
  assert.deepEqual(runDeskFill(opts).windows,[]);
  const insert = conn.prepare(`INSERT INTO candidate_pool
    (item_id,url,title,source,subtopic,desk,rel,first_seen,published,feed)
    VALUES (?,?,'Photon counter','New source','light','optics',.8,?,?,'Photon Monthly')`);
  for (const [id,day] of [['one','2031-06-01'],['two','2031-06-03']]) insert.run(id,id,day,day);
  conn.close();
  const first = runDeskFill(opts);
  assert.equal(first.windows[0].start,'2031-06-02');
  assert.equal(first.windows[0].end,'2031-06-03');
  opts.spec.end = '2031-06-02';
  const held = runDeskFill(opts);
  assert.deepEqual(held.review.map(r => r.id),['one']);
  assert.equal(held.windows[1].runs[0].stats.optics.fillRate,1);
  assert.equal(held.windows[1].runs[0].stats.optics.directFitRate,null);
  const judged = runDeskFill({ ...opts, judgments:held.review.map(r => ({ ...r, relevant:true })),
    spec:{ ...opts.spec, variants:[{ name:'greedy', selection:{ epsilon:0 }, grid:{ 'selection.shown_decay':[.2,.8] } }] } });
  assert.equal(judged.variants.length,2);
  assert.equal(judged.windows[1].runs[0].stats.optics.directFitRate,1);
  assert.equal(judged.windows[1].runs[0].stats.optics.sources['Photon Monthly'],1);
});
