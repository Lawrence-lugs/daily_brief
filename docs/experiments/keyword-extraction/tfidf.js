// TF-IDF over the candidate_pool in daily_brief.db
//
// Pure Node (no npm dependencies): reads item title+snippet from the pool,
// tokenizes, computes TF x IDF, and reports global + per-desk top terms.
//
// Usage:
//   node docs/experiments/keyword-extraction/tfidf.js [--db <path>] [--out <json>]
//
// Defaults: db = <project-root>/daily_brief.db, out = <folder>/tfidf_results.json

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_DB = resolve(ROOT, 'daily_brief.db');
const DEFAULT_OUT = resolve(__dirname, 'tfidf_results.json');

// RECOMMENDATIONS (from TF-IDF run on 2026-11-12, pool n=4963):
//   1. Strip arXiv boilerplate before TF-IDF: "Comments: …", "arXiv:…", and
//      pure-numeric/version tokens (e.g. "2610", "2026", "v1", "v2"). These leak
//      from snippets and dominate the global ranking ("comments" ranked #1).
//   2. Add light stemming so "model"/"models", "field"/"fields", "design"/"designs"
//      collapse into a single entry each (cosmetic, minor impact).
//   3. Rely on desk-conditioned (per-desk) term lists rather than a single global
//      list: the two desks (`science`, `primary`) have disjoint vocabularies, so a
//      global list is less informative than per-desk lists.
// See docs/experiments/keyword-extraction/REPORT.md for full results and analysis.

// Common English stopwords (domain-agnostic). Technical tokens are kept so the
// IDF stage decides whether they are distinctive or boilerplate.
const STOPWORDS = new Set([
  'a','about','above','after','again','against','all','am','an','and','any','are','aren\'t','as','at',
  'be','because','been','before','being','below','between','both','but','by','can\'t','cannot',
  'could','couldn\'t','did','didn\'t','do','does','doesn\'t','doing','don\'t','down','during','each',
  'few','for','from','further','had','hadn\'t','has','hasn\'t','have','haven\'t','having','he',
  'he\'d','he\'ll','he\'s','her','here','here\'s','hers','herself','him','himself','his','how',
  'how\'s','i','i\'d','i\'ll','i\'m','i\'ve','if','in','into','is','isn\'t','it','it\'s','its',
  'itself','let\'s','me','more','most','mustn\'t','my','myself','no','nor','not','of','off','on',
  'once','only','or','other','ought','our','ours','ourselves','out','over','own','same','shan\'t',
  'she','she\'d','she\'ll','she\'s','should','shouldn\'t','so','some','such','than','that','that\'s',
  'the','their','theirs','them','themselves','then','there','there\'s','these','they','they\'d',
  'they\'ll','they\'re','they\'ve','this','those','through','to','too','under','until','up','very',
  'was','wasn\'t','we','we\'d','we\'ll','we\'re','we\'ve','were','weren\'t','what','what\'s',
  'when','when\'s','where','where\'s','which','while','who','who\'s','whom','why','why\'s','with',
  'won\'t','would','wouldn\'t','you','you\'d','you\'ll','you\'re','you\'ve','your','yours',
  'yourself','yourselves','a','an','the','and','or','but','if','then','else','for','while','do',
  'via','using','used','use','uses','new','one','two','first','second','last','next','also','however',
  'therefore','thus','hence','may','might','could','would','should','can','will','would','shall',
  'show','shows','shown','present','presents','presented','propose','proposes','proposed','paper',
  'papers','study','studies','study','research','result','results','based','method','methods',
  'approach','approaches','introduce','introduces','introduced','work','works','work',
  'arxiv','abstract','introduction','conclusion','section','figure','fig','table','et al',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and short tokens. */
export function tokenize(text) {
  if (!text) return [];
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Build one document per pool item: id + token list from title + snippet. */
export function buildDocs(rows) {
  return rows.map((r) => ({
    id: r.item_id,
    title: r.title ?? '',
    desk: r.desk ?? '',
    subtopic: r.subtopic ?? '',
    source: r.source ?? '',
    source_type: r.source_type ?? '',
    tokens: tokenize(`${r.title ?? ''} ${r.snippet ?? ''}`),
  }));
}

/**
 * Compute TF-IDF for a corpus of documents.
 *
 * tf(t, d)   = count(t in d) / total tokens in d        (L1-normalized term frequency)
 * idf(t)     = ln((N + 1) / (df(t) + 1)) + 1            (smoothed inverse doc freq)
 * tfidf      = tf * idf
 *
 * Returns { vocab, idf, docs: [{id, title, desk, ..., docLen, terms:[{term,tf,idf,tfidf}]}], stats }
 */
export function computeTFIDF(docs) {
  const N = docs.length;
  const df = new Map();   // term -> number of docs containing it
  const docVecs = [];

  for (const d of docs) {
    const counts = new Map();
    for (const t of d.tokens) counts.set(t, (counts.get(t) || 0) + 1);
    const docLen = d.tokens.length;
    const seen = new Set(counts.keys());
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);

    const terms = [];
    for (const [term, count] of counts) {
      const tf = count / docLen;
      terms.push({ term, count, tf });
    }
    // Sort terms within doc by tf desc for stable output.
    terms.sort((a, b) => b.tf - a.tf || a.term.localeCompare(b.term));
    docVecs.push({ ...d, docLen, numTerms: counts.size, terms });
  }

  const idf = new Map();
  for (const [term, dfCount] of df) {
    idf.set(term, Math.log((N + 1) / (dfCount + 1)) + 1);
  }

  // Attach idf + tfidf to each term entry.
  for (const d of docVecs) {
    for (const te of d.terms) {
      te.idf = idf.get(te.term);
      te.tfidf = te.tf * te.idf;
    }
    d.terms.sort((a, b) => b.tfidf - a.tfidf || a.term.localeCompare(b.term));
  }

  const vocab = [...df.keys()].sort();
  const stats = {
    nDocs: N,
    vocabSize: vocab.length,
    totalTokens: docVecs.reduce((s, d) => s + d.docLen, 0),
    avgDocLen: docVecs.reduce((s, d) => s + d.docLen, 0) / N || 0,
    avgUniqueTerms: docVecs.reduce((s, d) => s + d.numTerms, 0) / N || 0,
  };
  return { vocab, idf, docs: docVecs, stats };
}

/** Global ranking of terms by aggregate TF-IDF weight across the corpus. */
export function globalRanking(result, top = 50) {
  const agg = new Map();
  for (const d of result.docs) {
    for (const te of d.terms) {
      const cur = agg.get(te.term) || { term: te.term, df: 0, sumTfIdf: 0, maxTfIdf: 0, nDocs: 0 };
      cur.df += 1;
      cur.sumTfIdf += te.tfidf;
      cur.maxTfIdf = Math.max(cur.maxTfIdf, te.tfidf);
      cur.nDocs += 1;
      agg.set(te.term, cur);
    }
  }
  const ranked = [...agg.values()].map((e) => ({
    ...e,
    meanTfIdf: e.sumTfIdf / e.nDocs,
    idf: result.idf.get(e.term),
  }));
  ranked.sort((a, b) => b.sumTfIdf - a.sumTfIdf || a.term.localeCompare(b.term));
  return ranked.slice(0, top);
}

/** Per-desk top terms (by sum of TF-IDF within the desk). */
export function deskRanking(result, top = 20) {
  const byDesk = new Map();
  for (const d of result.docs) {
    if (!byDesk.has(d.desk)) byDesk.set(d.desk, new Map());
    const m = byDesk.get(d.desk);
    for (const te of d.terms) {
      const cur = m.get(te.term) || { term: te.term, sumTfIdf: 0, nDocs: 0 };
      cur.sumTfIdf += te.tfidf;
      cur.nDocs += 1;
      m.set(te.term, cur);
    }
  }
  const out = {};
  for (const [desk, m] of byDesk) {
    const ranked = [...m.values()]
      .map((e) => ({ ...e, meanTfIdf: e.sumTfIdf / e.nDocs, idf: result.idf.get(e.term) }))
      .sort((a, b) => b.sumTfIdf - a.sumTfIdf || a.term.localeCompare(b.term))
      .slice(0, top);
    out[desk] = ranked;
  }
  return out;
}

/** Top TF-IDF terms for a single document. */
export function docTopTerms(d, top = 10) {
  return d.terms.slice(0, top).map((te) => ({ term: te.term, count: te.count, tf: te.tf, idf: te.idf, tfidf: te.tfidf }));
}

function parseArgs() {
  const args = { db: DEFAULT_DB, out: DEFAULT_OUT };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--db') args.db = process.argv[++i];
    else if (a === '--out') args.out = process.argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tfidf.js [--db <path>] [--out <json>]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const { db, out } = parseArgs();
  const ds = new DatabaseSync(db);
  ds.exec('PRAGMA busy_timeout=30000;');

  const rows = ds.prepare(
    `SELECT item_id, title, snippet, desk, subtopic, source, source_type, rel FROM candidate_pool ORDER BY item_id`
  ).all();
  ds.close();

  if (rows.length === 0) {
    console.error('[tfidf] candidate_pool is empty');
    process.exit(1);
  }

  const docs = buildDocs(rows);
  const result = computeTFIDF(docs);
  const global = globalRanking(result, 60);
  const byDesk = deskRanking(result, 25);

  const report = {
    generatedAt: new Date().toISOString(),
    db,
    nDocs: rows.length,
    stats: result.stats,
    globalTop: global,
    byDesk,
    perDoc: result.docs.map((d) => ({
      id: d.id,
      title: d.title,
      desk: d.desk,
      subtopic: d.subtopic,
      docLen: d.docLen,
      topTerms: docTopTerms(d, 10),
    })),
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify(report, null, 2));

  // Console summary
  console.error(`[tfidf] docs=${result.stats.nDocs} vocab=${result.stats.vocabSize} avgDocLen=${result.stats.avgDocLen.toFixed(1)}`);
  console.error(`[tfidf] global top terms:`);
  for (const g of global.slice(0, 20)) {
    console.error(`   ${g.term.padEnd(22)} df=${String(g.df).padStart(4)} idf=${g.idf.toFixed(3)} sumTfIdf=${g.sumTfIdf.toFixed(3)} meanTfIdf=${g.meanTfIdf.toFixed(4)}`);
  }
  console.error(`[tfidf] desks: ${Object.keys(byDesk).join(', ')}`);
  console.error(`[tfidf] wrote ${out}`);

  return report;
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { DEFAULT_DB, DEFAULT_OUT, STOPWORDS };
