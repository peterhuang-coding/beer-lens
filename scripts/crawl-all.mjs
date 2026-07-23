#!/usr/bin/env node
/**
 * crawl-all.mjs — 一键运行所有数据爬虫，填充 beer.db。
 *
 * Usage:
 *   npm run crawl                  # 全部源
 *   npm run crawl -- --source untappd --country CN  # 只爬中国区
 *   npm run crawl -- --cn-only      # 只导入中国精酿种子数据
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const PYTHON = "python3";
const ROOT = process.cwd();
const LOOKUP_SCRIPT = path.join(ROOT, ".beer-data", "lookup.py");
const REPORT_PATH = path.join(ROOT, "data", "crawl-report.json");

// ── Parse args ──
const args = process.argv.slice(2);
const cnOnly = args.includes("--cn-only");
const sourceArg = args.includes("--source") ? args[args.indexOf("--source") + 1] : "all";
const countryArg = args.includes("--country") ? args[args.indexOf("--country") + 1] : undefined;

// ── Steps ──

async function step(label, fn) {
  console.log(`\n=== ${label} ===`);
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ ${label}: ok (${elapsed}s)`, typeof result === 'object' ? JSON.stringify(result) : result);
    return { ok: true, result, elapsed };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`❌ ${label}: FAILED (${elapsed}s) — ${err.message}`);
    return { ok: false, error: err.message, elapsed };
  }
}

// ── Step 1: Import Chinese craft beers ──
async function importCNBeers() {
  const cnFile = path.join(ROOT, "data", "chinese-craft-beers.json");
  const { stdout } = await execFileAsync(PYTHON, [LOOKUP_SCRIPT, "--insert-cn-beers", cnFile], { timeout: 30_000 });
  return JSON.parse(stdout.trim());
}

// ── Step 2: Run Untappd crawler ──
async function runUntappdCrawl() {
  // Dynamic import of the crawler
  const { crawlUntappd } = await import("../lib/beer-agent/beer-db/crawlers/untappd.js");

  const options = { limit: 100 };
  if (countryArg) {
    options.countries = [countryArg];
    console.log(`  Targeting country: ${countryArg}`);
  }

  const result = await crawlUntappd(options);

  // Write results to DB via Python
  if (result.beers.length > 0) {
    const tmpFile = path.join(ROOT, "data", ".crawl-temp.json");
    await mkdir(path.dirname(tmpFile), { recursive: true });
    await writeFile(tmpFile, JSON.stringify(result.beers));
    await execFileAsync(PYTHON, [LOOKUP_SCRIPT, "--insert-cn-beers", tmpFile], { timeout: 30_000 });
    console.log(`  Wrote ${result.beers.length} beers to DB`);
  }

  return {
    beersFound: result.beers.length,
    pagesCrawled: result.pagesCrawled,
    errors: result.errors,
  };
}

// ── Step 3: Get current stats ──
async function getStats() {
  const { stdout } = await execFileAsync(PYTHON, [LOOKUP_SCRIPT, "--stats"], { timeout: 10_000 });
  return JSON.parse(stdout.trim());
}

// ── Main ──

async function main() {
  console.log("🍺 Beer Lens — Data Crawl Pipeline");
  console.log(`Source: ${sourceArg} | CN-only: ${cnOnly} | Country: ${countryArg || 'all'}\n`);

  const results = {};

  // Step 1: CN beers (always run)
  results.cnBeers = await step("Import Chinese craft beers", importCNBeers);

  if (!cnOnly) {
    // Step 2: Untappd crawl
    if (sourceArg === "all" || sourceArg === "untappd") {
      results.untappd = await step("Untappd crawl", runUntappdCrawl);
    }
  }

  // Step 3: Show final stats
  results.stats = await step("DB Stats", getStats);
  console.log(`\n📊 Final Stats: ${JSON.stringify(results.stats.result, null, 2)}`);

  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    source: sourceArg,
    country: countryArg || null,
    cnOnly,
    results,
  };
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report: ${REPORT_PATH}`);
}

main().catch(err => {
  console.error("❌ Crawl failed:", err);
  process.exit(1);
});
