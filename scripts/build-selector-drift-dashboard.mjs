#!/usr/bin/env node
/**
 * scripts/build-selector-drift-dashboard.mjs
 *
 * Regenerate docs/selector-drift.html from
 * data/crawler/selector-probe/{baseline.json,probes.jsonl,drifts.jsonl}.
 *
 * The page is a self-contained static HTML (no JS, no assets) with:
 *   - header (head sha + timestamp)
 *   - overall summary tile (baseline time, latest probe, drift count)
 *   - per-source selector matrix (rows = probe targets, columns =
 *     baseline / latest / drift status) — green/red
 *   - drift log table (from drifts.jsonl)
 *
 * Reuses the CSS tokens from build-harness-dashboard.mjs so the two
 * pages feel like one app.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const OUT = join(ROOT, "docs/selector-drift.html");
const DATA = join(ROOT, "data/crawler/selector-probe");

// ── helpers ───────────────────────────────────────────────────────────────

async function readJSON(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function readJSONL(p) {
  const txt = await readFile(p, "utf8").catch(() => "");
  return txt
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const DRIFT_THRESHOLD = 0.20;

// ── data load ─────────────────────────────────────────────────────────────

const baseline = await readJSON(join(DATA, "baseline.json")).catch(() => null);
const probes = await readJSONL(join(DATA, "probes.jsonl"));
const drifts = await readJSONL(join(DATA, "drifts.jsonl"));

// latest per-target matched count (last occurrence wins).
const latestById = new Map();
const latestRun = new Map();
for (const run of probes) {
  latestRun.set(`${run.source}/${run.surface}`, run.ts);
  for (const t of run.targets) {
    latestById.set(t.id, {
      matched: t.matched,
      ts: run.ts,
      sample: t.sample,
      url: run.url,
    });
  }
}

// join baseline → latest → drift status
const rows = (baseline?.targets ?? []).map((b) => {
  const cur = latestById.get(b.id);
  const latest = cur?.matched ?? 0;
  let delta = 0;
  if (b.matched === 0) {
    delta = latest === 0 ? 0 : 1;
  } else if (latest === 0) {
    delta = 1;
  } else {
    delta = Math.abs(latest - b.matched) / b.matched;
  }
  return {
    id: b.id,
    source: b.id.split(".")[0],
    surface: b.id.split(".")[1],
    name: b.id,
    baseline: b.matched,
    latest,
    delta,
    drift: delta > DRIFT_THRESHOLD,
    sample: cur?.sample ?? [],
  };
});

const driftCount = rows.filter((r) => r.drift).length;
const okCount = rows.length - driftCount;
const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
const head = safeExec("git", ["rev-parse", "--short", "HEAD"]);
const baselineTs = baseline?.ts ?? "—";

// group rows by source for the matrix
const bySource = new Map();
for (const r of rows) {
  if (!bySource.has(r.source)) bySource.set(r.source, []);
  bySource.get(r.source).push(r);
}

// ── render ────────────────────────────────────────────────────────────────

function matrixRows(rs) {
  return rs
    .map((r) => {
      const cell = (val, drift) =>
        `<td class="num ${drift ? "drift" : "ok"}">${val}</td>`;
      const sample = (r.sample ?? [])
        .slice(0, 2)
        .map((s) => `<code>${htmlEscape(s)}</code>`)
        .join(" ");
      return `      <tr>
        <td class="name">${htmlEscape(r.name)}</td>
        <td class="surface">${htmlEscape(r.surface)}</td>
        ${cell(r.baseline, false)}
        ${cell(r.latest, r.drift)}
        <td class="status ${r.drift ? "drift" : "ok"}">${r.drift ? "DRIFT" : "OK"}</td>
        <td class="sample">${sample}</td>
      </tr>`;
    })
    .join("\n");
}

function sourceBlock(source, rs) {
  const list = rs.filter((r) => r.surface === "list");
  const detail = rs.filter((r) => r.surface === "detail");
  const matrix = (label, rows) => {
    if (rows.length === 0) return "";
    return `<h3>${label}</h3>
    <table>
      <thead><tr><th>target</th><th>surface</th><th>baseline</th><th>latest</th><th>status</th><th>sample</th></tr></thead>
      <tbody>
${matrixRows(rows)}
      </tbody>
    </table>`;
  };
  return `<section class="harness">
    <div class="harness-head">
      <h2>${htmlEscape(source)}</h2>
      <span class="counts"><b>${rs.length}</b> targets · <b>${rs.filter((r) => r.drift).length}</b> drifts</span>
    </div>
    ${matrix("list page", list)}
    ${matrix("detail page", detail)}
  </section>`;
}

const sourceSections = [...bySource.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([source, rs]) => sourceBlock(source, rs))
  .join("\n");

const driftRows = drifts
  .map(
    (d) =>
      `<tr>
        <td class="ts">${htmlEscape(d.ts)}</td>
        <td>${htmlEscape(d.source)}</td>
        <td>${htmlEscape(d.surface)}</td>
        <td class="name">${htmlEscape(d.name)}</td>
        <td class="num">${d.baseline_matched}</td>
        <td class="num">${d.latest_matched}</td>
        <td class="num">${(d.delta_ratio * 100).toFixed(1)}%</td>
      </tr>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beer-Lens Selector Drift</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1f232c; --border: #2a2f3a;
    --fg: #e8eaf0; --fg-dim: #9aa3b2; --accent: #f5a524; --accent-2: #4cb3ff;
    --green: #4ade80; --red: #f87171; --pill-on: #166534; --pill-off: #4b5563;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
  header { padding: 28px 40px 18px; border-bottom: 1px solid var(--border); }
  header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
  header .meta { color: var(--fg-dim); font-size: 12px; }
  header .meta code { background: var(--panel); padding: 1px 6px; border-radius: 4px; color: var(--accent); }
  main { padding: 28px 40px 60px; display: grid; gap: 32px; max-width: 1280px; margin: 0 auto; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 22px; }
  .tile .label { color: var(--fg-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .tile .value { font-size: 28px; font-weight: 700; color: var(--accent); margin-top: 6px; }
  .tile.ok .value { color: var(--green); }
  .tile.warn .value { color: var(--red); }
  .harness { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .harness-head { padding: 18px 24px; background: var(--panel-2); border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .harness-head h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--accent); text-transform: capitalize; }
  .harness-head .counts { margin-left: auto; color: var(--fg-dim); font-size: 12px; }
  .harness-head .counts b { color: var(--fg); font-weight: 600; }
  h3 { margin: 18px 24px 8px; font-size: 12px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.6px; }
  table { width: calc(100% - 48px); margin: 0 24px 18px; border-collapse: collapse; font-size: 12px; }
  thead th { background: var(--panel-2); color: var(--fg-dim); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); font-weight: 600; }
  tbody td { padding: 8px 10px; border-bottom: 1px solid var(--border); font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  tbody tr:last-child td { border-bottom: none; }
  td.name { color: var(--accent-2); }
  td.surface { color: var(--fg-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  td.num.ok { color: var(--green); }
  td.num.drift { color: var(--red); font-weight: 700; }
  td.status.drift { color: var(--red); font-weight: 700; }
  td.status.ok { color: var(--green); }
  td.sample code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px; color: var(--fg-dim); display: inline-block; margin: 1px 0; word-break: break-all; font-size: 10px; }
  .empty { padding: 24px; color: var(--fg-dim); font-size: 13px; text-align: center; }
  footer { padding: 16px 40px 40px; color: var(--fg-dim); font-size: 12px; text-align: center; }
  footer code { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Beer-Lens Selector Drift</h1>
  <div class="meta">
    Repo <code>/Volumes/SanDisk2TB/beer-lens</code> ·
    HEAD <code>${htmlEscape(head)}</code> ·
    Generated <code>${htmlEscape(ts)}</code> ·
    Baseline <code>${htmlEscape(baselineTs)}</code> ·
    Threshold <code>${(DRIFT_THRESHOLD * 100).toFixed(0)}%</code>
  </div>
</header>
<main>
  <section class="summary">
    <div class="tile"><div class="label">probe targets</div><div class="value">${rows.length}</div></div>
    <div class="tile ok"><div class="label">within tolerance</div><div class="value">${okCount}</div></div>
    <div class="tile ${driftCount > 0 ? "warn" : "ok"}"><div class="label">drift alerts</div><div class="value">${driftCount}</div></div>
    <div class="tile"><div class="label">drift log entries</div><div class="value">${drifts.length}</div></div>
  </section>

  ${sourceSections || `<section class="harness"><div class="empty">no probes recorded yet — run <code>npm run selector-probe</code></div></section>`}

  <section class="harness">
    <div class="harness-head">
      <h2>drift log</h2>
      <span class="counts"><b>${drifts.length}</b> entries · data/crawler/selector-probe/drift*.jsonl</span>
    </div>
    ${
      drifts.length === 0
        ? `<div class="empty">no drift detected — every probe target is within ${(DRIFT_THRESHOLD * 100).toFixed(0)}% of baseline.</div>`
        : `<table>
      <thead><tr><th>timestamp</th><th>source</th><th>surface</th><th>target</th><th>baseline</th><th>latest</th><th>Δ</th></tr></thead>
      <tbody>
${driftRows}
      </tbody>
    </table>`
    }
  </section>
</main>
<footer>
  self-contained · no JS · no assets · regenerated by <code>scripts/build-selector-drift-dashboard.mjs</code> · sibling of <a href="harness-platform.html" style="color:var(--accent-2);">harness-platform.html</a>
</footer>
</body>
</html>
`;

await writeFile(OUT, html, "utf8");
console.log(`✓ wrote ${OUT} (${html.length} bytes)`);
console.log(`  ${rows.length} targets · ${okCount} ok · ${driftCount} drift · ${drifts.length} log entries`);