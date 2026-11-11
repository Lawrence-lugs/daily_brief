/**
 * Idempotent migration: rename `category` -> `desk` in perfect_samples.json.
 *
 * Decision 6 mapping:
 *   core: true  -> desk: "primary"  (Silicon & Architecture)
 *   core: false -> desk: "science"
 *
 * Idempotent: samples that already have a `desk` field are left untouched.
 * Runs: node tools/migrate_perfect_samples.js [perfect_samples.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_PATH = 'perfect_samples.json';
const path = process.argv[2] ?? DEFAULT_PATH;

const samples = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(samples)) {
  throw new Error(`${path}: expected a JSON array of perfect samples`);
}

let changed = 0;
for (const s of samples) {
  if (s.desk !== undefined) continue; // already migrated
  if (s.category !== undefined) {
    s.desk = s.core === true ? 'primary' : 'science';
    delete s.category;
    changed++;
  } else if (s.core !== undefined && s.desk === undefined) {
    // category missing entirely: infer from core
    s.desk = s.core === true ? 'primary' : 'science';
    changed++;
  }
}

writeFileSync(path, JSON.stringify(samples, null, 2) + '\n');
console.error(`migrated ${changed} sample(s) in ${path} (desk already set on ${samples.length - changed})`);
