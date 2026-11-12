// Child-process entry for one brief run. Spawned by jobs.js (forkRunBrief) so that the CPU-bound
// work (ranker fit, embeddings, ...) never runs on the HTTP server's event loop. Receives the
// run flags over IPC, runs brief.js main(), reports the exit code back, and exits.
import { main } from './brief.js';

process.once('message', async (flags) => {
  let exitCode;
  try {
    exitCode = await main(flags);
  } catch (e) {
    process.send({ error: e?.message ?? String(e) }, () => process.exit(1));
    return;
  }
  process.send({ exitCode }, () => process.exit(exitCode));
});
