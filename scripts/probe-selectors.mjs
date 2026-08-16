#!/usr/bin/env node
/**
 * scripts/probe-selectors.mjs
 *
 * Probe every declared selector against captured HTML and write:
 *   - baseline.json   snapshot of the latest run (fixture-based) used
 *                     as the comparison baseline for drift detection
 *   - probes.jsonl    one JSONL line per probe run, with timestamp
 *                     and matched counts
 *   - drifts.jsonl    appended only when latest vs baseline deviates
 *                     more than DRIFT_THRESHOLD on any target
 *
 * CLI flags:
 *   --fixture       (default true) probe the existing fixture HTML
 *   --live          (default false) additionally hit one untappd + one
 *                   ratebeer detail URL at 1 req/s; results feed the
 *                   drift detector. Off by default — live network is
 *                   out of scope for unit tests.
 *   --out <dir>     output dir (default data/crawler/selector-probe)
 *
 * No deps. Pure stdlib.
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DEFAULT_OUT = join(ROOT, "data/crawler/selector-probe");
const FIXTURE_DIR = join(ROOT, "data/crawler/_fixtures");

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { fixture: true, live: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = true;
    else if (a === "--live") args.live = true;
    else if (a === "--no-fixture") args.fixture = false;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/probe-selectors.mjs [--no-fixture] [--live] [--out <dir>]",
      );
      process.exit(0);
    }
  }
  return args;
}

// ── tsx loader: run the TS module through node --experimental-strip-types ─

async function importTs(rel) {
  return await import(rel);
}

// ── live network probe (throttled 1 req/s) ────────────────────────────────

const THROTTLE_MS = 1000;

async function fetchWithJitter(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "beer-lens-selector-probe/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

const LIVE_URLS = [
  {
    source: "untappd",
    surface: "detail",
    url: "https://untappd.com/beer/One-Beer/1",
  },
  {
    source: "ratebeer",
    surface: "detail",
    url: "https://www.ratebeer.com/beer/panda-ipa/123456/",
  },
];

async function liveProbes() {
  const results = [];
  for (const { source, surface, url } of LIVE_URLS) {
    try {
      console.log(`  · live fetch: ${url}`);
      const html = await fetchWithJitter(url);
      const { runProbe } = await importTs(
        join(ROOT, "lib/crawler/selector-probe.ts"),
      );
      results.push({
        source,
        surface,
        url,
        results: runProbe(html, source, surface),
      });
    } catch (err) {
      console.warn(
        `  ! live probe failed for ${url}: ${err.message ?? err}`,
      );
    }
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }
  return results;
}

// ── fixture probes ─────────────────────────────────────────────────────────

const FIXTURE_PROBES = [
  // untappd list
  { source: "untappd", surface: "list", file: "untappd-top.html" },
  // untappd detail — use the info tab fixture (single page, has all 5 tabs)
  { source: "untappd", surface: "detail", file: "untappd-detail-info.html" },
  // ratebeer list + detail
  { source: "ratebeer", surface: "list", file: "ratebeer-cn-list.html" },
  { source: "ratebeer", surface: "detail", file: "ratebeer-detail-cn.html" },
];

async function fixtureProbes() {
  const { runProbe } = await importTs(
    join(ROOT, "lib/crawler/selector-probe.ts"),
  );
  const out = [];
  for (const { source, surface, file } of FIXTURE_PROBES) {
    const html = await readFile(join(FIXTURE_DIR, file), "utf8");
    out.push({
      source,
      surface,
      url: `fixture://${file}`,
      results: runProbe(html, source, surface),
    });
  }
  return out;
}

// ── output writers ────────────────────────────────────────────────────────

async function writeJsonl(path, records) {
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(path, text, "utf8");
}

async function appendJsonl(path, record) {
  await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const ts = new Date().toISOString();
  const head = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
    } catch {
      return "unknown";
    }
  })();

  console.log(`→ probe-selectors · out=${args.out}`);
  console.log(`  head=${head} ts=${ts}`);

  // 1. collect probe results
  const allRuns = [];
  if (args.fixture) {
    console.log(`  · fixture probes (${FIXTURE_PROBES.length})`);
    const fr = await fixtureProbes();
    for (const r of fr) allRuns.push({ ...r, ts });
  }
  if (args.live) {
    console.log(`  · live probes (${LIVE_URLS.length}, 1 req/s)`);
    const lr = await liveProbes();
    for (const r of lr) allRuns.push({ ...r, ts });
  }

  if (allRuns.length === 0) {
    console.warn("  ! no probes collected; nothing to write");
    return;
  }

  // 2. write per-run JSONL (one record per (source, surface) tuple)
  const probesPath = join(args.out, "probes.jsonl");
  for (const run of allRuns) {
    const flat = {
      ts: run.ts,
      head,
      source: run.source,
      surface: run.surface,
      url: run.url,
      targets: run.results.map((r) => ({
        id: r.id,
        name: r.name,
        matched: r.matched,
        sample: r.sample,
      })),
    };
    await appendJsonl(probesPath, flat);
  }
  console.log(`  ✓ ${probesPath}`);

  // 3. baseline.json — flatten the fixture (or first) run into a
  //    per-target lookup keyed by id. Used as the comparison baseline
  //    for future runs.
  const baselinePath = join(args.out, "baseline.json");
  const baselineMap = {};
  for (const run of allRuns) {
    for (const r of run.results) baselineMap[r.id] = r.matched;
  }
  const baseline = {
    ts,
    head,
    source: "fixture+live",
    targets: Object.entries(baselineMap).map(([id, matched]) => ({
      id,
      matched,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  await writeJson(baselinePath, baseline);
  console.log(
    `  ✓ ${baselinePath} (${baseline.targets.length} targets)`,
  );

  // 4. drift detection — compare live runs (if any) against the
  //    fixture baseline. Writes drifts.jsonl on deviations > 20%.
  const { detectDrift } = await importTs(
    join(ROOT, "lib/crawler/selector-probe.ts"),
  );
  const baselineResults = allRuns
    .filter((r) => r.url.startsWith("fixture://"))
    .flatMap((r) => r.results);
  const latestResults = allRuns
    .filter((r) => !r.url.startsWith("fixture://"))
    .flatMap((r) => r.results);

  if (latestResults.length > 0 && baselineResults.length > 0) {
    const drifts = detectDrift(baselineResults, latestResults);
    if (drifts.length > 0) {
      const driftPath = join(args.out, "drifts.jsonl");
      for (const d of drifts) await appendJsonl(driftPath, d);
      console.log(`  ⚠ ${driftPath} (${drifts.length} drifts)`);
    } else {
      console.log(`  ✓ no drift (latest within 20% of baseline)`);
    }
  }

  console.log(`done.`);
}

main().catch((err) => {
  console.error("probe-selectors failed:", err);
  process.exit(1);
});