// Child-process stand-in for brief.js main(): CPU-bound for `ms` (from the job flags, default 3000),
// writing the same log/progress files the real run writes.
import { writeFileSync, renameSync } from 'node:fs';

process.once('message', (flags) => {
  const ms = Number(flags.fixtureMs ?? 3000);
  writeFileSync(flags.logFile, 'fitting...\n');
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy: stands in for the LR fit */ }
  writeFileSync(flags.logFile, 'fitting...\ndone\n');
  if (flags.progressFile) {
    writeFileSync(flags.progressFile + '.tmp', JSON.stringify({ v: 1, seq: 1, phase: 'done', engine: 'lr', t0: 1, desks: {} }));
    renameSync(flags.progressFile + '.tmp', flags.progressFile);
  }
  process.send({ exitCode: 0 }, () => process.exit(0));
});
