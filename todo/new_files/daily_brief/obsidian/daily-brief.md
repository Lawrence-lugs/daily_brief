```dataviewjs
// Daily brief: thin iframe onto the local server (desktop only). Docs: 98-Scripts/daily_brief/README.md
const ROOT_REL = "98-Scripts/daily_brief";
const PORT = 4873;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const root = dv.container;
root.empty();

if (app.isMobile) { root.createEl("p", { text: "The daily brief needs the local server, so it is desktop-only." }); return; }

const http = window.require("http");
const cp = window.require("child_process");
const path = window.require("path");
const { shell } = window.require("electron");
const base = path.join(app.vault.adapter.getBasePath(), ROOT_REL);

const healthy = () => new Promise((resolve) => {
  const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 800 }, (res) => {
    let b = ""; res.on("data", (d) => (b += d));
    res.on("end", () => { try { resolve(JSON.parse(b).name === "daily-brief"); } catch { resolve(false); } });
  });
  r.on("error", () => resolve(false));
  r.on("timeout", () => { r.destroy(); resolve(false); });
});

const status = root.createEl("p", { text: "Starting brief server..." });
if (!(await healthy())) {
  const child = cp.spawn("node", [path.join(base, "server", "index.js"), "--port", String(PORT)],
    { cwd: base, detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (e) => status.setText("Could not start node: " + e.message));
  child.unref();
  for (let i = 0; i < 50 && !(await healthy()); i++) await new Promise((r) => setTimeout(r, 200));
}
if (!(await healthy())) { status.setText("Brief server did not start."); return; }
status.remove();

const isDark = () => document.body.classList.contains("theme-dark");
const theme = () => (isDark() ? "dark" : "light");
const frame = root.createEl("iframe");
// allow-same-origin: the page needs its own (localhost) origin for fetch/POST to work.
frame.setAttribute("sandbox", "allow-same-origin allow-scripts");
frame.style.cssText = "width:100%;height:85vh;border:0;border-radius:12px;";
frame.src = `${ORIGIN}/?embed=1&theme=${theme()}`;

const mo = new MutationObserver(() => frame.contentWindow?.postMessage({ type: "theme", theme: theme() }, "*"));
mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
const onMsg = (e) => {
  if (e.source !== frame.contentWindow || e.data?.type !== "open-url") return;
  if (/^https?:\/\//i.test(e.data.url)) shell.openExternal(e.data.url);
};
window.addEventListener("message", onMsg);
dv.component.register(() => { mo.disconnect(); window.removeEventListener("message", onMsg); });
```
