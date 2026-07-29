#!/usr/bin/env node
/**
 * untappd-crawler.mjs — Browser-based Untappd scraper.
 *
 * STATUS: Cloudflare Managed Challenge blocks headless access.
 * This script is wired up but BY DEFAULT cannot bypass the challenge.
 *
 * To actually scrape Untappd, ONE of the following is required:
 *   (A) User provides Untappd session cookies (--cookies <json-file>)
 *   (B) User runs Chrome with --remote-debugging-port and we connect
 *       via CDP (--cdp http://localhost:9222)
 *   (C) User logs into Untappd once in non-headless Chromium we launch
 *       (--headed and --user-data-dir <profile-path>)
 *
 * Once past Cloudflare, the script scrapes search/beer pages and writes
 * verified entries to harness.py cache.
 *
 * Usage:
 *   node scripts/untappd-crawler.mjs --search "Sleep HopFan" --cookies /tmp/untappd-cookies.json
 *   node scripts/untappd-crawler.mjs --queryfile data/round-2.json --cookies cookies.json --limit 5 --cache
 *   node scripts/untappd-crawler.mjs --cdp http://localhost:9222 --search "Pliny the Elder"
 *
 * Cookie file format (array of {name, value, domain, path}):
 *   [{ "name": "untappd_session", "value": "abc123...", "domain": ".untappd.com", "path": "/" }]
 *
 * To get cookies:
 *   1. Open Chrome, go to untappd.com, log in, pass any Cloudflare challenge
 *   2. DevTools → Application → Cookies → untappd.com → copy all
 *   3. Save as JSON, pass via --cookies
 *
 * For non-Untappd sites (brewery official, XHS, etc.), this script works
 * without cookies.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const HARNESS = path.join(ROOT, ".beer-data", "harness.py");

// ── Args ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    search: null,
    url: null,
    queryfile: null,
    limit: 5,
    cache: false,
    cookies: null,           // path to JSON cookies file
    cdp: null,               // CDP endpoint e.g. http://localhost:9222
    userDataDir: null,       // path to Chromium profile dir
    headed: false,           // show browser (user can interact)
    timeoutMs: 30_000,
    output: null,
    dryRun: false,           // don't write cache, just print results
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--search" || a === "-s") args.search = argv[++i];
    else if (a === "--url" || a === "-u") args.url = argv[++i];
    else if (a === "--queryfile" || a === "-f") args.queryfile = argv[++i];
    else if (a === "--limit" || a === "-l") args.limit = parseInt(argv[++i]) || 5;
    else if (a === "--cache") args.cache = true;
    else if (a === "--cookies" || a === "-c") args.cookies = argv[++i];
    else if (a === "--cdp") args.cdp = argv[++i];
    else if (a === "--user-data-dir") args.userDataDir = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--output" || a === "-o") args.output = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`untappd-crawler.mjs — Browser-based Untappd scraper.

⚠️  Cloudflare blocks headless access by default. Need cookies / CDP / headed.

Usage:
  --search 'TEXT'             Search Untappd by name; takes first result.
  --url 'URL'                 Direct beer page URL.
  --queryfile PATH            JSON of targets [{name, brewery}, ...].
  --limit N                   Max targets from queryfile (default 5).

Auth bypass:
  --cookies PATH              JSON file with [{name, value, domain, path}, ...]
  --cdp URL                   Connect to existing Chrome via CDP
  --user-data-dir PATH        Use this Chromium profile dir (with logged-in state)
  --headed                    Show browser window (user can solve challenges manually)

Output:
  --cache                     Also write to harness.py cache (verified=true).
  --output PATH               Write results JSON to file.
  --dry-run                   Don't write cache, just print.

Example:
  # 1. Extract cookies from your logged-in Chrome
  # 2. Save them to cookies.json
  # 3. Run:
  node scripts/untappd-crawler.mjs \\
    --queryfile data/round-2.json \\
    --cookies /tmp/untappd-cookies.json \\
    --limit 5 --cache
`);
}

// ── Browser factory ─────────────────────────────────────────────

async function makeContext(args) {
  if (args.cdp) {
    const browser = await chromium.connectOverCDP(args.cdp);
    const contexts = browser.contexts();
    return { browser, context: contexts[0] || (await browser.newContext()) };
  }

  const launchOpts = {
    headless: args.headed ? false : true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  };

  if (args.userDataDir) {
    const ctx = await chromium.launchPersistentContext(args.userDataDir, launchOpts);
    return { browser: ctx.browser(), context: ctx };
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  // Inject cookies if provided
  if (args.cookies) {
    const cookies = JSON.parse(await readFile(args.cookies, "utf8"));
    await context.addCookies(cookies);
    console.error(`🍪 Injected ${cookies.length} cookies`);
  }

  return { browser, context };
}

// ── Scraper ─────────────────────────────────────────────────────

async function searchUntappd(context, query, timeoutMs) {
  const page = await context.newPage();
  try {
    const searchUrl = `https://untappd.com/search?q=${encodeURIComponent(query)}&type=beer`;
    await page.goto(searchUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/b/']", { timeout: 15_000 }).catch(() => null);

    const firstHref = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a[href*='/b/']"));
      const beerLinks = links.filter((a) => /\/b\/\d+/.test(a.getAttribute("href") || ""));
      return beerLinks.length > 0 ? beerLinks[0].href : null;
    });

    if (!firstHref) {
      const title = await page.title();
      const isCloudflare = title === "Just a moment..." || (await page.content()).includes("cf-chl");
      return { error: isCloudflare ? "cloudflare_blocked" : "no_results", query, hint: isCloudflare ? "need --cookies / --cdp / --headed" : null };
    }
    return await scrapeBeerPage(context, firstHref, timeoutMs);
  } finally {
    await page.close();
  }
}

async function scrapeBeerPage(context, url, timeoutMs) {
  const page = await context.newPage();
  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await page.waitForSelector(".beer-info, .name, .abv, .num", { timeout: 15_000 }).catch(() => null);

    const data = await page.evaluate(() => {
      const nameEl = document.querySelector(".beer-info .name, .name h1, .beer-details .name");
      const breweryEl = document.querySelector(".brewery a, .beer-info .brewery a");
      const abvEl = document.querySelector(".abv .abv-value, .abv .num, [data-abv]");
      const ibuEl = document.querySelector(".ibu .ibu-value, .ibu .num, [data-ibu]");
      const styleEl = document.querySelector(".style a, .beer-info .style");
      const ratingEl = document.querySelector(".rating .caps, .rating .num, .num");
      const countEls = Array.from(document.querySelectorAll(".count, .check-ins, .ratings-count"));

      let abv = null;
      if (abvEl) {
        const m = (abvEl.textContent || "").match(/(\d+\.?\d*)\s*%/);
        if (m) abv = parseFloat(m[1]);
      }
      let ibu = null;
      if (ibuEl) {
        const m = (ibuEl.textContent || "").match(/(\d+)/);
        if (m) ibu = parseInt(m[1]);
      }
      let rating = null;
      if (ratingEl) {
        const m = (ratingEl.textContent || "").match(/(\d+\.?\d*)/);
        if (m) rating = parseFloat(m[1]);
      }
      let ratings_count = null;
      for (const el of countEls) {
        const m = (el.textContent || "").replace(/,/g, "").match(/(\d+)/);
        if (m) {
          ratings_count = parseInt(m[1]);
          break;
        }
      }

      return {
        name: nameEl?.textContent?.trim() || null,
        brewery: breweryEl?.textContent?.trim() || null,
        style: styleEl?.textContent?.trim() || null,
        abv, ibu, rating, ratings_count,
      };
    });

    return {
      ...data,
      untappd_url: url,
      source: "untappd",
      captured_at: new Date().toISOString(),
      verified: false,
    };
  } finally {
    await page.close();
  }
}

// ── Cache write ─────────────────────────────────────────────────

function runHarnessCache(payload) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [HARNESS, "cache", JSON.stringify(payload)], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ ok: true, raw: stdout }); }
      } else {
        reject(new Error(`harness.py exit ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { browser, context } = await makeContext(args);

  try {
    let results = [];

    if (args.search) {
      const r = await searchUntappd(context, args.search, args.timeoutMs);
      results.push({ query: args.search, ...r });
    } else if (args.url) {
      const r = await scrapeBeerPage(context, args.url, args.timeoutMs);
      results.push({ query: args.url, ...r });
    } else if (args.queryfile) {
      const raw = JSON.parse(await readFile(args.queryfile, "utf8"));
      const targets = (Array.isArray(raw) ? raw : (raw.targets || [])).slice(0, args.limit);
      console.error(`🔎 Crawling ${targets.length} targets via Untappd`);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const query = `${t.name} ${t.brewery}`;
        process.stderr.write(`  [${i + 1}/${targets.length}] ${query} ... `);
        try {
          const r = await searchUntappd(context, query, args.timeoutMs);
          if (r.error) {
            process.stderr.write(`❌ ${r.error}${r.hint ? ` (${r.hint})` : ""}\n`);
            results.push({ query, ...r });
            // If Cloudflare blocks us, abort remaining targets
            if (r.error === "cloudflare_blocked") {
              console.error("\n🛑 Cloudflare detected. Stopping to save budget.");
              console.error("   Fix: pass --cookies <file> or --cdp <url> or --user-data-dir <path>");
              break;
            }
          } else {
            process.stderr.write(`✅ ${r.name || "?"} ABV=${r.abv} rating=${r.rating}\n`);
            results.push({ query, ...r });
          }
          if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
          process.stderr.write(`❌ ${err.message}\n`);
          results.push({ query, error: err.message });
        }
      }
    } else {
      console.error("❌ Need --search, --url, or --queryfile");
      process.exit(1);
    }

    if (args.cache && !args.dryRun) {
      for (const r of results) {
        if (r.error || !r.name) continue;
        try {
          const out = await runHarnessCache({
            name: r.name,
            brewery: r.brewery,
            style: r.style,
            abv: r.abv,
            rating: r.rating,
            ratings_count: r.ratings_count,
            ibu: r.ibu,
            source_url: r.untappd_url,
            source_platform: "Untappd-Playwright",
            verified: true,
          });
          console.error(`  cached: ${r.name} → ${out.ok ? "ok" : "fail"}`);
        } catch (err) {
          console.error(`  cache failed for ${r.name}: ${err.message}`);
        }
      }
    }

    if (args.output) {
      await writeFile(args.output, JSON.stringify(results, null, 2) + "\n");
      console.error(`📄 Wrote ${results.length} results to ${args.output}`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error(`\n❌ crawler failed: ${err.message}`);
  process.exit(1);
});