// Child-process stand-in for brief_child.js: reports exit 0 only when launched with
// ELECTRON_RUN_AS_NODE=1 (as forkRunBrief must do, since the packaged app's execPath is Electron).
process.once('message', () => {
  process.send({ exitCode: process.env.ELECTRON_RUN_AS_NODE === '1' ? 0 : 1 });
});
