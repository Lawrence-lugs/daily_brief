#!/usr/bin/env node
// CLI wrapper for the refactored JS brief generator (server/lib/brief.js).
//
// Usage:
//   node scripts/run_brief.js                       # full run: fetch + select + LLM edit + persist
//   node scripts/run_brief.js --dry-run             # everything except persisting to the DB
//   node scripts/run_brief.js --no-llm              # raw items per desk, no OpenRouter calls
//   node scripts/run_brief.js --no-fetch            # reuse the persisted candidate pool
//   node scripts/run_brief.js --engine keyword
//   node scripts/run_brief.js --dry-run --no-llm --no-fetch
//
// Flags mirror the former `python src/brief.py` options. Logs go to stderr
// (and to --log-file if given). Exit code 0 = success, non-zero = failure.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../server/lib/brief.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`
Usage: node scripts/run_brief.js [options]

Generate the daily brief using the JS port (server/lib/brief.js).

Options:
  --dry-run             Run fetch/select/edit but do not persist to the DB
  --no-llm              Skip the OpenRouter editor; show raw items per desk
  --no-fetch            Reuse the persisted candidate pool (skip fetching)
  --refresh-api-feeds   Background API refresh only (no brief generation)
  --engine lr|keyword   Selection engine (default: config.ranker.engine, usually lr)
  --seed N              RNG seed for selection
  --log-file PATH       Also write the run log to this file
  --progress-file PATH  Write progress JSON to this file
  --help, -h            Show this help
`.trim());
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--no-llm':
        flags.noLlm = true;
        break;
      case '--no-fetch':
        flags.noFetch = true;
        break;
      case '--refresh-api-feeds':
        flags.refreshApiFeeds = true;
        break;
      case '--engine':
        flags.engine = argv[++i];
        break;
      case '--seed':
        flags.seed = Number(argv[++i]);
        break;
      case '--log-file':
        flags.logFile = argv[++i];
        break;
      case '--progress-file':
        flags.progressFile = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        console.error(`unknown argument: ${a}`);
        printHelp();
        process.exit(2);
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

main(flags).then((code) => {
  process.exit(code ?? 0);
}).catch((e) => {
  console.error(`brief.js threw: ${e.message}`);
  process.exit(1);
});
