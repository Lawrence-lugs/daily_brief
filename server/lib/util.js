/** Shared, tiny utilities used across the brief modules (port of src/util.py).

WARNINGS is a mutable list so every module appends to the same log.
LOG_FILE is rebound by brief.main (--log-file) and read by the fetcher when
starting the background API refresh; modules must read it as
`util.LOG_FILE` at call time rather than copying the reference.
*/
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const WARNINGS = [];
export let LOG_FILE = null;

export function setLogFile(file) { LOG_FILE = file; }

export function log(msg) {
  console.error(msg);
  if (LOG_FILE) {
    try {
      const dir = path.dirname(LOG_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(LOG_FILE, msg + '\n', 'utf8');
    } catch {
      // Never let a logging problem kill the run; the message still
      // reached stderr above.
    }
  }
}

export function warn(msg) {
  WARNINGS.push(msg);
  log(`warn: ${msg}`);
}
