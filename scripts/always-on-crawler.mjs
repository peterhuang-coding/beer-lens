#!/usr/bin/env node
/**
 * always-on-crawler.mjs — Build a target list for the AI crawler round.
 *
 * Does NOT call WebSearch itself. The beer-lens skill (v6.0) consumes the
 * generated target list and does the actual WebSearch → verify → cache
 * loop. This keeps the script pure-logic / unit-testable and isolates the
 * LLM budget to the skill invocation.
 *
 * Sources (priority order):
 *   0. warm_list gaps from harness.py warm-list (cache misses on WARM_LIST)
 *   1. user-supplied targets (--targets <json-file>)
 *   2. data/chinese-craft-beers.json filtered by --breweries / --countries
 *
 * Usage:
 *   node scripts/always-on-crawler.mjs                              # default round
 *   node scripts/always-on-crawler.mjs --round 1 --limit 30         # round 1, 30 targets
 *   node scripts/always-on-crawler.mjs --gap-only --print           # show warm-list gaps only
 *   node scripts/always-on-crawler.mjs --breweries "Jing-A,Master Gao" --countries China
 *   node scripts/always-on-crawler.mjs --targets data/my-list.json
 *   node scripts/always-on-crawler.mjs --dry-run                    # preview, no write
 *   node scripts/always-on-crawler.mjs --output data/round-1.json
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dedupeAndMerge, filterByBrewery, filterByCountry, shapeOutput } from "./always-on-crawler-lib.mjs";

const ROOT = process.cwd();
const PYTHON = "python3";
const HARNESS = path.join(ROOT, ".beer-data", "harness.py");
const CN_SEED = path.join(ROOT, "data", "chinese-craft-beers.json");
const DEFAULT_OUTPUT = "data/round-targets.json";

// ── Args ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    round: null,
    limit: 30,
    breweries: [],
    countries: ["China"],
    targets: null,
    output: DEFAULT_OUTPUT,
    print: false,
    dryRun: false,
    gapOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--round" || a === "-r") args.round = argv[++i];
    else if (a === "--limit" || a === "-l") args.limit = parseInt(argv[++i]) || 30;
    else if (a === "--breweries" || a === "-b") args.breweries = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--countries" || a === "-c") args.countries = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--targets" || a === "-t") args.targets = argv[++i];
    else if (a === "--output" || a === "-o") args.output = argv[++i];
    else if (a === "--print" || a === "-p") args.print = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--gap-only") args.gapOnly = true;
    else if (a === "--help" || a === "-h") { args.help = true; }
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`always-on-crawler.mjs — Build target list for AI crawler round

Usage:
  node scripts/always-on-crawler.mjs [options]

Options:
  --round, -r <n>          Round number (logged in output)
  --limit, -l <n>          Max targets in output (default 30)
  --breweries, -b <csv>    Filter CN seeds by brewery (substring match, case-insensitive)
  --countries, -c <csv>    Filter CN seeds by country (default: China)
  --targets, -t <path>     User-supplied JSON file of extra targets
  --output, -o <path>      Output JSON path (default: data/round-targets.json)
  --print, -p              Print to stdout instead of writing file
  --dry-run                Preview only, never write
  --gap-only               Only include warm_list gaps, skip CN seeds
  --help, -h               Show this help

Output JSON shape:
  {
    "generatedAt": ISO,
    "round": n | null,
    "limit": n,
    "filters": { "breweries": [], "countries": [] },
    "summary": { "p0_gaps": n, "p1_user": n, "p2_seeds": n, "total": n },
    "targets": [
      { "name": str, "brewery": str, "priority": "p0_gap"|"p1_user"|"p2_seed", "country"?: str, "chinese_name"?: str, "chinese_brewery"?: str }
    ]
  }
`);
}

// ── Harness subprocess ──────────────────────────────────────────

function runHarness(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [HARNESS, ...args], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`harness.py returned non-JSON: ${stdout.slice(0, 200)}`)); }
      } else {
        reject(new Error(`harness.py exit ${code}: ${stderr.slice(0, 300)}`));
      }
    });
    proc.on("error", reject);
  });
}

// ── Source loaders ──────────────────────────────────────────────

async function loadGaps(limit) {
  // harness.py warm-list returns gaps (verified=0 or missing from cache)
  const list = await runHarness(["warm-list", "--limit", String(limit)]);
  if (!Array.isArray(list)) return [];
  return list.map((g) => ({
    name: g.name,
    brewery: g.brewery,
    priority: "p0_gap",
  }));
}

async function loadUserTargets(pathOrNull) {
  if (!pathOrNull) return [];
  try {
    const raw = JSON.parse(await readFile(pathOrNull, "utf8"));
    const items = Array.isArray(raw) ? raw : (raw.targets || raw.beers || []);
    return items
      .filter((t) => t && t.name && t.brewery)
      .map((t) => ({
        name: String(t.name).trim(),
        brewery: String(t.brewery).trim(),
        priority: "p1_user",
        chinese_name: t.chinese_name,
        chinese_brewery: t.chinese_brewery,
        country: t.country,
      }));
  } catch (err) {
    throw new Error(`Failed to load --targets ${pathOrNull}: ${err.message}`);
  }
}

async function loadCnSeeds({ breweries, countries, limit }) {
  let raw;
  try {
    raw = JSON.parse(await readFile(CN_SEED, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${CN_SEED}: ${err.message}`);
  }
  const items = Array.isArray(raw) ? raw : (raw.beers || []);

  const filtered = filterByBrewery(items, breweries);
  const filteredByCountry = filterByCountry(filtered, countries);

  return filteredByCountry.slice(0, limit).map((b) => ({
    name: b.name,
    brewery: b.brewery,
    priority: "p2_seed",
    chinese_name: b.chinese_name,
    chinese_brewery: b.chinese_brewery,
    country: b.country || "China",
    style: b.style,
  }));
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  const now = new Date().toISOString();
  console.log(`🍺 always-on-crawler round=${args.round ?? "n/a"} limit=${args.limit} gapOnly=${args.gapOnly} dryRun=${args.dryRun}`);

  const limit = args.gapOnly ? args.limit : Math.max(args.limit, 30);

  // P0: warm_list gaps
  const gaps = await loadGaps(limit);
  console.log(`  [P0] warm_list gaps: ${gaps.length}`);

  // P1: user-supplied
  const user = await loadUserTargets(args.targets);
  console.log(`  [P1] user targets: ${user.length}`);

  // P2: CN seeds (skip if gapOnly)
  let seeds = [];
  if (!args.gapOnly) {
    seeds = await loadCnSeeds({
      breweries: args.breweries,
      countries: args.countries,
      limit,
    });
    console.log(`  [P2] cn seeds: ${seeds.length}`);
  }

  const targets = dedupeAndMerge({ gaps, user, seeds }, args.limit);
  console.log(`  → merged unique: ${targets.length} (cap=${args.limit})`);

  const output = shapeOutput({
    generatedAt: now,
    round: args.round,
    limit: args.limit,
    filters: { breweries: args.breweries, countries: args.countries },
    gaps, user, seeds, targets,
  });

  if (args.print) {
    console.log("\n--- Targets ---");
    for (const t of targets) {
      console.log(`  [${t.priority}] ${t.name} — ${t.brewery}${t.country ? ` (${t.country})` : ""}`);
    }
    console.log(`\n${JSON.stringify(output, null, 2)}`);
  } else if (!args.dryRun) {
    const outPath = path.resolve(ROOT, args.output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(output, null, 2) + "\n");
    console.log(`📄 Wrote ${targets.length} targets to ${path.relative(ROOT, outPath)}`);
  } else {
    console.log("🛑 dry-run: no file written");
  }
}

main().catch((err) => {
  console.error(`\n❌ always-on-crawler failed: ${err.message}`);
  process.exit(1);
});