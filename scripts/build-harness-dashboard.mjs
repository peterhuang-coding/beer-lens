#!/usr/bin/env node
/**
 * build-harness-dashboard.mjs
 *
 * Regenerate docs/harness-platform.html from manifest + crawler modules.
 * No runtime deps — pure Node stdlib.
 *
 * Usage:
 *   node scripts/build-harness-dashboard.mjs
 *   npm run harness:dashboard
 */

import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// ── helpers ───────────────────────────────────────────────────────────────

async function readJSON(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function lineCount(p) {
  const txt = await readFile(p, "utf8");
  return txt.split("\n").length;
}

async function globFiles(dir, suffix) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (suffix && !e.name.endsWith(suffix)) continue;
    out.push(join(dir, e.name));
  }
  return out.sort();
}

function execSafe(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ── data collection ───────────────────────────────────────────────────────

const manifest = await readJSON(join(ROOT, "data/skills/manifest.json"));
const builtinSkills = manifest.skills.filter((s) =>
  manifest.defaultEnabled.includes(s.id),
);

// shared handler detection
const handlerCounts = new Map();
for (const s of builtinSkills) {
  handlerCounts.set(s.handlerFile, (handlerCounts.get(s.handlerFile) ?? 0) + 1);
}

const crawlerFiles = await globFiles(join(ROOT, "lib/crawler"), ".ts");
const crawlerMd = await globFiles(join(ROOT, "lib/crawler"), ".md");
const fixtureFiles = await globFiles(
  join(ROOT, "data/crawler/_fixtures"),
  ".html",
);

const crawlerModules = [];
for (const f of [...crawlerFiles, ...crawlerMd].sort()) {
  const name = f.split("/").pop();
  const isMd = name.endsWith(".md");
  const loc = isMd ? "spec" : await lineCount(f);
  crawlerModules.push({ name, loc, full: f.replace(`${ROOT}/`, "") });
}

const head = execSafe("git", ["rev-parse", "--short", "HEAD"]);
const now = new Date().toISOString().slice(0, 19).replace("T", " ");

// ── render ────────────────────────────────────────────────────────────────

const skillCards = builtinSkills
  .map((s) => {
    const shared = handlerCounts.get(s.handlerFile) > 1;
    const pills = [
      `<span class="pill ${s.enabled ? "on" : "off"}">${s.enabled ? "ON" : "OFF"}</span>`,
    ];
    if (shared) pills.push(`<span class="pill shared">shared</span>`);
    return `      <div class="skill">
        <div class="skill-head"><span class="skill-id">${htmlEscape(s.id)}</span><span class="skill-label">${htmlEscape(s.label)}</span></div>
        <div class="skill-desc">${htmlEscape(s.description)}</div>
        <div class="skill-foot">${pills.join("\n          ")}</div>
        <div class="path">${htmlEscape(s.handlerFile)}</div>
      </div>`;
  })
  .join("\n\n");

const crawlerRows = crawlerModules
  .map(
    (m) =>
      `    <div class="module">
      <span class="module-name">${htmlEscape(m.name)}</span>
      <span class="module-loc">${htmlEscape(String(m.loc))}${typeof m.loc === "number" ? " LoC" : ""}</span>
      <span class="module-desc">${htmlEscape(m.full)}</span>
    </div>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beer-Lens Harness Platform</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1f232c; --border: #2a2f3a;
    --fg: #e8eaf0; --fg-dim: #9aa3b2; --accent: #f5a524; --accent-2: #4cb3ff;
    --green: #4ade80; --pill-on: #166534; --pill-off: #4b5563;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
  header { padding: 28px 40px 18px; border-bottom: 1px solid var(--border); }
  header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
  header .meta { color: var(--fg-dim); font-size: 12px; }
  header .meta code { background: var(--panel); padding: 1px 6px; border-radius: 4px; color: var(--accent); }
  main { padding: 28px 40px 60px; display: grid; gap: 32px; max-width: 1200px; margin: 0 auto; }
  .harness { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .harness-head { padding: 18px 24px; background: var(--panel-2); border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .harness-head h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--accent); }
  .harness-head .sub { color: var(--fg-dim); font-size: 12px; }
  .harness-head .counts { margin-left: auto; color: var(--fg-dim); font-size: 12px; }
  .harness-head .counts b { color: var(--fg); font-weight: 600; }
  .skills { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1px; background: var(--border); }
  .skill { background: var(--panel); padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
  .skill-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .skill-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; color: var(--accent-2); }
  .skill-label { font-weight: 600; font-size: 14px; }
  .skill-desc { color: var(--fg-dim); font-size: 12px; min-height: 2.6em; }
  .skill-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  .pill { font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; }
  .pill.on { background: var(--pill-on); color: #d1fae5; }
  .pill.off { background: var(--pill-off); color: #d1d5db; }
  .pill.shared { background: #1e3a8a; color: #bfdbfe; }
  .path { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: var(--fg-dim); word-break: break-all; }
  .module { padding: 14px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 14px; }
  .module:last-child { border-bottom: none; }
  .module-name { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--accent-2); font-size: 13px; min-width: 220px; }
  .module-loc { color: var(--green); font-size: 11px; min-width: 80px; }
  .module-desc { color: var(--fg-dim); font-size: 12px; }
  .legend { padding: 14px 24px; color: var(--fg-dim); font-size: 12px; background: var(--panel-2); border-top: 1px solid var(--border); }
  .legend code { color: var(--accent); }
  footer { padding: 16px 40px 40px; color: var(--fg-dim); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>🍺 Beer-Lens Harness Platform</h1>
  <p style="margin:8px 0 0;"><a href="selector-drift.html">→ Live Selector Probe</a></p>
  <div class="meta">
    Repo <code>/Volumes/SanDisk2TB/beer-lens</code> ·
    HEAD <code>${htmlEscape(head)}</code> ·
    Generated <code>${htmlEscape(now)}</code> ·
    2 harnesses · <b>${builtinSkills.length}</b> builtin skills · <b>${crawlerModules.length}</b> crawler modules
  </div>
</header>
<main>

  <section class="harness">
    <div class="harness-head">
      <h2>1. Skills Harness</h2>
      <span class="sub">lib/harness/{types,router,skill-registry}.ts</span>
      <span class="counts"><b>${builtinSkills.length}</b> builtin skills · <b>${handlerCounts.size}</b> executors</span>
    </div>
    <div class="skills">

${skillCards}

    </div>
    <div class="legend">
      <code>preferredHandler: "active"</code> 走 active pipeline 平行；
      legacy <code>lib/beer-agent/orchestrator.ts</code> 保留为参考，待 v0.2 加 <code>@deprecated</code>。
    </div>
  </section>

  <section class="harness">
    <div class="harness-head">
      <h2>2. Crawler Harness</h2>
      <span class="sub">lib/crawler/*.ts · bin/beer-lens-crawl.mjs · data/crawler/_fixtures/</span>
      <span class="counts"><b>${crawlerModules.length}</b> modules · <b>${fixtureFiles.length}</b> fixtures · <b>1</b> CLI entry</span>
    </div>

${crawlerRows}

    <div class="legend">
      CLI: <code>node bin/beer-lens-crawl.mjs --help</code> ·
      测试: <code>node --test tests/crawler-*.test.mts</code> ·
      数据: <code>node bin/beer-lens-crawl.mjs --source untappd --limit 100 --dry-run</code>
    </div>
  </section>

</main>
<footer>
  self-contained · no JS · no assets · regenerated by <code>scripts/build-harness-dashboard.mjs</code>
</footer>
</body>
</html>
`;

const outPath = join(ROOT, "docs/harness-platform.html");
await writeFile(outPath, html, "utf8");
console.log(`✓ wrote ${outPath} (${html.length} bytes)`);
console.log(`  ${builtinSkills.length} skills · ${crawlerModules.length} crawler modules · ${fixtureFiles.length} fixtures`);
