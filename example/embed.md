```dataviewjs
// Daily brief. Docs: 98-Scripts/daily_brief/README.md
const SCRIPT = "98-Scripts/daily_brief/src/brief.py";
const PYTHON = "python";

// Where the frontend sources the brief from (vault-relative).  The generator
// is pointed at this same directory via --out so it writes exactly here.
const DIR = "05-for-agents/daily-brief";
const ad = app.vault.adapter;
const root = dv.container;
root.empty();

const bar = root.createDiv({ cls: "daily-brief-bar" });
const status = bar.createSpan();
const btn = bar.createEl("button", { text: "Generate brief" });
const logBtn = bar.createEl("button", { text: "Logs" });
const reRenderBtn = bar.createEl("button", { text: "Re-render" });
const logPopup = root.createDiv();
logPopup.style.cssText = "display:none;position:fixed;right:1rem;bottom:1rem;z-index:9999;width:min(48rem,90vw);max-height:55vh;padding:0.75rem;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:8px;box-shadow:0 4px 24px #0005;";
const logText = logPopup.createEl("pre");
logText.style.cssText = "max-height:calc(55vh - 2rem);overflow:auto;white-space:pre-wrap;font-size:0.75rem;";
logText.setText("Logs appear here while a brief is being generated.");
logBtn.onclick = () => {
  logPopup.style.display = logPopup.style.display === "none" ? "" : "none";
};
// Re-render: rebuild today's HTML from current CSS/templates only (no fetch/LLM),
// then refresh the iframe. Faster than a full Generate; desktop-only.
reRenderBtn.onclick = async () => {
  reRenderBtn.disabled = true;
  reRenderBtn.setText("Re-rendering...");
  status.style.color = "";
  status.setText("Re-rendering brief from current CSS/templates...");
  logPath = path.join(os.tmpdir(), `daily-brief-rerender-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  fs.writeFileSync(logPath, "", "utf8");
  lastLogText = "";
  generationFinished = false;
  logDeadline = Date.now() + 15 * 60 * 1000;
  logText.setText("Waiting for generator output...");
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(readLogs, 500);
  cp.execFile(PYTHON, [SCRIPT, "--re-render", "--log-file", logPath, "--out", DIR], { cwd: ad.getBasePath(), timeout: 600000, windowsHide: true, maxBuffer: 1 << 24 },
    async (err, stdout, stderr) => {
      reRenderBtn.disabled = false;
      reRenderBtn.setText("Re-render");
      generationFinished = true;
      // Refresh the iframe from disk once the re-render has exited,
      // before cleaning up the temp log.
      await load();
      if (err) {
        const tail = (stderr || err.message).trim().split("\n").slice(-2).join(" ");
        status.setText("Re-render failed: " + tail);
        status.style.color = "var(--text-error)";
      } else {
        status.setText("Brief re-rendered.");
      }
      readLogs(); // final read; removes the temp log once completion is detected
    });
};
const frame = root.createEl("iframe");
frame.setAttribute("sandbox", "allow-same-origin allow-scripts"); 
frame.style.cssText = "width:100%;height:600px;border:0;border-radius:12px;";

const isDark = () => document.body.classList.contains("theme-dark");
const resize = () => {
  const d = frame.contentDocument;
  if (d && d.documentElement) frame.style.height = d.documentElement.scrollHeight + 2 + "px";
};
const applyTheme = () => {
  const d = frame.contentDocument;
  if (!d || !d.documentElement) return;
  d.documentElement.classList.remove("dark", "light");
  d.documentElement.classList.add(isDark() ? "dark" : "light");
  resize();
};
frame.addEventListener("load", () => {
  const d = frame.contentDocument;
  if (!d) return;
  d.addEventListener("click", (e) => { // open story links in the system browser
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const url = a.href;
    if (!/^(https?|mailto):/i.test(url)) return; // ignore #anchors, about:srcdoc, etc.
    try {
      const { shell } = window.require("electron");
      shell.openExternal(url);
    } catch (err) {
      window.open(url); // mobile fallback, where electron isn't available
    }
  });
  applyTheme();
});
const mo = new MutationObserver(applyTheme);
mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
const ro = new ResizeObserver(resize);
ro.observe(root);
let logTimer = null;
let logPath = null;
let lastLogText = "";
let generationFinished = false;
let logDeadline = 0;
function readLogs() {
  if (!logPath) return;
  try {
    lastLogText = fs.readFileSync(logPath, "utf8");
    logText.setText(lastLogText || "Waiting for generator output...");
    logText.scrollTop = logText.scrollHeight;
    const backgroundStarted = lastLogText.includes("API background refresh started");
    const backgroundFinished = lastLogText.includes("API background refresh complete");
    const generationDone = lastLogText.includes("brief generation done");
    if (generationFinished && (generationDone || !backgroundStarted || backgroundFinished || Date.now() >= logDeadline)) {
      clearInterval(logTimer);
      logTimer = null;
      try { fs.unlinkSync(logPath); } catch (e) { console.warn("Could not remove temporary brief log", e); }
      logPath = null;
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read temporary brief log", e);
  }
}
// Save/like toggles arrive from the iframe; write them to YYYY-MM-DD.json beside the HTML.
let stateWrites = Promise.resolve();
const onBriefState = (e) => {
  if (e.source !== frame.contentWindow) return;
  const msg = e.data;
  if (!msg || msg.type !== "brief-state" || !/^\d{4}-\d{2}-\d{2}$/.test(msg.date)) return;
  const body = JSON.stringify({ date: msg.date, stories: msg.stories }, null, 1);
  stateWrites = stateWrites
    .then(() => ad.write(`${DIR}/${msg.date}.json`, body))
    .catch((err) => console.error("Could not save brief state", err));
};
window.addEventListener("message", onBriefState);
dv.component.register(() => {
  mo.disconnect();
  ro.disconnect();
  if (logTimer) clearInterval(logTimer);
  window.removeEventListener("message", onBriefState);
});

async function load() {
  let latest = null;
  try {
    const { files } = await ad.list(DIR);
    latest = files.filter(f => /\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().pop();
  } catch (e) { /* folder not created yet */ }
  if (!latest) {
    status.setText("No brief yet. Click Generate.");
    frame.style.display = "none";
    return;
  }
  const date = latest.match(/(\d{4}-\d{2}-\d{2})\.html$/)[1];
  const stale = date !== window.moment().format("YYYY-MM-DD");
  status.setText(stale ? `Latest brief is from ${date} (not today)` : `Brief for ${date}`);
  status.style.color = stale ? "var(--text-warning)" : "";
  await stateWrites;
  let html = await ad.read(latest);
  let dayState = { stories: {} };
  try {
    const stateFile = `${DIR}/${date}.json`;
    if (await ad.exists(stateFile)) dayState = JSON.parse(await ad.read(stateFile));
  } catch (e) { console.error("Could not read brief state", e); }
  const stateJson = JSON.stringify({ date, stories: dayState.stories || {} }).replace(/</g, "\\u003c");
  html = html.replace(/<script id="brief-state">[\s\S]*?<\/script>/, () => `<script id="brief-state">window.BRIEF_STATE = ${stateJson};</script>`);
  html = html.replace('<html lang="en">', `<html lang="en" class="${isDark() ? "dark" : "light"}">`);
  frame.style.display = "";
  frame.srcdoc = html;
}

let cp = null;
let fs = null, os = null, path = null;
try {
  cp = window.require("child_process");
  fs = window.require("fs");
  os = window.require("os");
  path = window.require("path");
} catch (e) { /* mobile */ }
if (!cp || app.isMobile) {
  btn.style.display = "none"; // generation is desktop-only; mobile just displays the synced file
  logBtn.style.display = "none";
  reRenderBtn.style.display = "none"; // re-render also needs desktop python
} else {
  btn.onclick = () => {
    btn.disabled = true;
    btn.setText("Generating...");
    status.style.color = "";
    status.setText("Fetching feeds and asking the model (about a minute)...");
    logPath = path.join(os.tmpdir(), `daily-brief-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    fs.writeFileSync(logPath, "", "utf8");
    lastLogText = "";
    generationFinished = false;
    logDeadline = Date.now() + 15 * 60 * 1000;
    logText.setText("Waiting for generator output...");
    if (logTimer) clearInterval(logTimer);
    logTimer = setInterval(readLogs, 500);
    cp.execFile(PYTHON, [SCRIPT, "--log-file", logPath, "--out", DIR], { cwd: ad.getBasePath(), timeout: 600000, windowsHide: true, maxBuffer: 1 << 24 },
      async (err, stdout, stderr) => {
        btn.disabled = false;
        btn.setText("Regenerate");
        generationFinished = true;
        // Always refresh the iframe from disk once the process has exited,
        // before cleaning up the temp log.
        await load();
        if (err) {
          const tail = (stderr || err.message).trim().split("\n").slice(-2).join(" ");
          status.setText("Generation failed: " + tail);
          status.style.color = "var(--text-error)";
        } else {
          status.setText("Brief generated.");
        }
        readLogs(); // final read; removes the temp log once completion is detected
      });
  };
}
await load();
if (frame.style.display !== "none") btn.setText("Regenerate");
```
