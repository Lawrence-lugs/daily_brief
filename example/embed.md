

Sample dataview snippet that can run or retrieve the daily brief 

```dataviewjs
// Daily brief. Docs: 98-Scripts/daily_brief/README.md
const DIR = "05-for-agents/daily-brief";
const SCRIPT = "98-Scripts/daily_brief/brief.py";
const PYTHON = "python";

const ad = app.vault.adapter;
const root = dv.container;
root.empty();

const bar = root.createDiv({ cls: "daily-brief-bar" });
const status = bar.createSpan();
const btn = bar.createEl("button", { text: "Generate brief" });
const frame = root.createEl("iframe");
frame.setAttribute("sandbox", "allow-same-origin"); // no scripts run inside; we can still set its theme
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
dv.component.register(() => { mo.disconnect(); ro.disconnect(); });

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
  let html = await ad.read(latest);
  html = html.replace('<html lang="en">', `<html lang="en" class="${isDark() ? "dark" : "light"}">`);
  frame.style.display = "";
  frame.srcdoc = html;
}

let cp = null;
try { cp = window.require("child_process"); } catch (e) { /* mobile */ }
if (!cp || app.isMobile) {
  btn.style.display = "none"; // generation is desktop-only; mobile just displays the synced file
} else {
  btn.onclick = () => {
    btn.disabled = true;
    btn.setText("Generating...");
    status.style.color = "";
    status.setText("Fetching feeds and asking the model (about a minute)...");
    cp.execFile(PYTHON, [SCRIPT], { cwd: ad.getBasePath(), timeout: 600000, windowsHide: true, maxBuffer: 1 << 24 },
      async (err, stdout, stderr) => {
        btn.disabled = false;
        btn.setText("Regenerate");
        await load();
        if (err) {
          const tail = (stderr || err.message).trim().split("\n").slice(-2).join(" ");
          status.setText("Generation failed: " + tail);
          status.style.color = "var(--text-error)";
        }
      });
  };
}
await load();
if (frame.style.display !== "none") btn.setText("Regenerate");
```


