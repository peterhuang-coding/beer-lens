/* dashboard.js — Beer Lens Skill Hub frontend
 *
 * Fetches from /api/* endpoints and renders 4 panels.
 * No build step, no framework. Uses Chart.js (CDN) for the DB growth curve.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function fmtNum(n) {
  if (n == null) return "—";
  if (typeof n !== "number") return String(n);
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}

function statusClass(status) {
  return `status-${(status || "skipped").toLowerCase()}`;
}

function featureStateClass(state) {
  return `state state-${(state || "backlog").toLowerCase()}`;
}

// ─── Panel 1: Daily crawler data ──────────────────────────────

async function renderCrawlLog() {
  const tbody = $("#crawl-tbody");
  const summary = $("#crawl-summary");
  let log = [];
  try {
    log = await fetchJson("/api/crawl-log");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">⚠️ ${err.message}</td></tr>`;
    return;
  }

  // KPIs
  const verified = log.filter((e) => e.status === "verified").length;
  const skipped = log.filter((e) => e.status === "skipped").length;
  const failed = log.filter((e) => e.status === "failed").length;
  summary.innerHTML = `
    <div class="kpi"><div class="label">total entries</div><div class="value">${fmtNum(log.length)}</div></div>
    <div class="kpi"><div class="label">verified</div><div class="value status-verified">${fmtNum(verified)}</div></div>
    <div class="kpi"><div class="label">skipped</div><div class="value">${fmtNum(skipped)}</div></div>
    <div class="kpi"><div class="label">failed</div><div class="value status-failed">${fmtNum(failed)}</div></div>
  `;

  if (log.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No crawl-log entries yet. Run <code>node scripts/always-on-crawler.mjs</code> to start.</td></tr>`;
    return;
  }

  // Newest first, cap 50 rows
  const rows = log.slice().reverse().slice(0, 50);
  tbody.innerHTML = rows.map((r) => {
    const ts = r.ts ? new Date(r.ts).toLocaleString() : (r.crawledAt || "—");
    const round = r.round ?? "—";
    const beer = r.target?.name || r.name || "—";
    const brewery = r.target?.brewery || r.brewery || "—";
    const status = r.status || "—";
    const abv = r.abv ?? "—";
    const rating = r.rating ?? "—";
    const sources = Array.isArray(r.sources) ? r.sources.join(", ") : (r.source_platform || "—");
    return `<tr>
      <td>${ts}</td>
      <td>${round}</td>
      <td>${beer}</td>
      <td>${brewery}</td>
      <td class="${statusClass(status)}">${status}</td>
      <td>${abv}</td>
      <td>${rating}</td>
      <td>${sources}</td>
    </tr>`;
  }).join("");
}

// ─── Panel 2: DB growth curve ─────────────────────────────────

let dbChart = null;

async function renderDbStats() {
  let stats = {};
  try {
    stats = await fetchJson("/api/stats");
  } catch (err) {
    $("#db-kpis").innerHTML = `<div class="kpi"><div class="label">error</div><div class="value status-failed">${err.message}</div></div>`;
    return;
  }

  const cache = stats.beer_cache || {};
  const untappd = stats.untappd_cache || {};
  $("#db-kpis").innerHTML = `
    <div class="kpi"><div class="label">verified beers</div><div class="value">${fmtNum(cache.verified)} / ${fmtNum(cache.total)}</div></div>
    <div class="kpi"><div class="label">untappd cache</div><div class="value">${fmtNum(untappd.total)}</div><div class="sub">${fmtNum(untappd.null_ids || 0)} null ids</div></div>
    <div class="kpi"><div class="label">total beers (RateBeer)</div><div class="value">${fmtNum(stats.total_beers)}</div></div>
    <div class="kpi"><div class="label">breweries</div><div class="value">${fmtNum(stats.total_breweries)}</div></div>
    <div class="kpi"><div class="label">avg rating</div><div class="value">${fmtNum(stats.avg_rating)}</div></div>
  `;

  // DB growth chart: pull snapshots if any, otherwise single-point chart
  let snapshots = [];
  try { snapshots = await fetchJson("/api/snapshots"); } catch { /* ignore */ }

  const now = new Date().toISOString().slice(0, 10);
  const series = [
    { date: now, verified: cache.verified || 0, total: cache.total || 0 },
    ...snapshots.map((s) => {
      const m = s.match(/stats-(\d{4}-\d{2}-\d{2})/);
      return { date: m ? m[1] : s, verified: 0, total: 0 }; // placeholder; real snapshots would be parsed
    }),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const labels = series.map((s) => s.date);
  const verifiedData = series.map((s) => s.verified);

  if (dbChart) dbChart.destroy();
  const ctx = $("#db-chart").getContext("2d");
  dbChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "verified beers", data: verifiedData, borderColor: "#3fb950", backgroundColor: "rgba(63,185,80,0.15)", tension: 0.3, fill: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" }, beginAtZero: true },
      },
    },
  });
}

// ─── Panel 3: API surfaces ────────────────────────────────────

async function renderApis() {
  const grid = $("#apis-grid");
  let data = {};
  try { data = await fetchJson("/api/apis"); } catch (err) {
    grid.innerHTML = `<div class="card"><div class="title">error</div><div class="body">${err.message}</div></div>`;
    return;
  }

  const cards = [];
  for (const s of (data.scripts || [])) {
    cards.push(`
      <div class="card">
        <div class="title">${s.name}</div>
        <div class="body">${s.cmd}</div>
        <div class="state state-ready">npm run</div>
      </div>
    `);
  }
  for (const c of (data.harnessCmds || [])) {
    cards.push(`
      <div class="card">
        <div class="title">${c.name}</div>
        <div class="body">python3 .beer-data/harness.py ${c.name}</div>
        <div class="state state-done">harness</div>
      </div>
    `);
  }
  // Add server's own endpoints
  for (const ep of ["stats", "health", "crawl-log", "features", "apis", "snapshots"]) {
    cards.push(`
      <div class="card">
        <div class="title">GET /api/${ep}</div>
        <div class="body">http://localhost:8888/api/${ep}</div>
        <div class="state state-running">hub</div>
      </div>
    `);
  }
  grid.innerHTML = cards.join("") || `<div class="card"><div class="body">No APIs found.</div></div>`;
}

// ─── Panel 4: Features ────────────────────────────────────────

async function renderFeatures() {
  const grid = $("#features-grid");
  let raw = "";
  try { raw = await fetchJson("/api/features"); } catch (err) {
    grid.innerHTML = `<div class="card"><div class="body">⚠️ ${err.message}</div></div>`;
    return;
  }
  // pm-feature.sh list output is markdown. Parse just the [state] rows for now.
  // Format: "[state] F-id | timestamp"
  const lines = (typeof raw === "string" ? raw : (raw.stdout || "")).split("\n");
  const cards = [];
  let inBeerLens = false;
  for (const line of lines) {
    if (/^##\s+beer-lens\b/i.test(line)) { inBeerLens = true; continue; }
    if (/^##\s+/.test(line)) { inBeerLens = false; continue; }
    if (!inBeerLens) continue;
    const m = line.match(/\[(\w[\w-]*)\]\s+(\S+)\s*\|\s*([^\n]*)/);
    if (!m) continue;
    const [, state, id, ts] = m;
    cards.push(`
      <div class="card">
        <div class="title">${id}</div>
        <div class="body">${ts.trim()}</div>
        <div class="${featureStateClass(state)}">${state}</div>
      </div>
    `);
  }
  if (cards.length === 0) {
    grid.innerHTML = `<div class="card"><div class="body">No beer-lens features found.</div></div>`;
    return;
  }
  grid.innerHTML = cards.join("");
}

// ─── Health badge ─────────────────────────────────────────────

async function renderHealth() {
  const badge = $("#meta-health");
  try {
    const h = await fetchJson("/api/health");
    badge.textContent = `health: ${h.healthy ? "OK" : "DEGRADED"} (${h.verified_entries}/${h.cache_entries})`;
    badge.className = `badge ${h.healthy ? "" : "warn"}`;
  } catch (err) {
    badge.textContent = `health: ERROR`;
    badge.className = "badge err";
  }
}

// ─── Boot ─────────────────────────────────────────────────────

async function main() {
  $("#meta-time").textContent = `last refresh: ${new Date().toLocaleString()}`;
  await Promise.allSettled([
    renderHealth(),
    renderCrawlLog(),
    renderDbStats(),
    renderApis(),
    renderFeatures(),
  ]);
  // Refresh every 30 seconds
  setTimeout(() => location.reload(), 30_000);
}

document.addEventListener("DOMContentLoaded", main);