#!/usr/bin/env node
/**
 * crawl-raw-sources.mjs — Web crawler for raw data images and metadata.
 *
 * Usage:
 *   node scripts/crawl-raw-sources.mjs --seed-file data/raw-crawl/sources.json --limit 20
 *   node scripts/crawl-raw-sources.mjs --dry-run
 *   node scripts/crawl-raw-sources.mjs --check-images
 *
 * Supports fixture:// protocol for local HTML testing without network.
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();

// ── Pure helpers (self-contained for standalone script) ──

function normalizeUrl(url) {
  try {
    const u = new URL(url.trim());
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

function hashKey(...parts) {
  const input = parts.map((p) => normalizeUrl(p)).join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractOgTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (match) return decodeEntities(match[1]).trim();
  return undefined;
}

function extractOgDescription(html) {
  const match = html.match(
    /<meta\s[^>]*?(?:property\s*=\s*["']og:description["']|name\s*=\s*["']description["'])[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (match) return decodeEntities(match[1]).trim();
  const alt = html.match(
    /<meta\s[^>]*?name\s*=\s*["']description["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (alt) return decodeEntities(alt[1]).trim();
  return undefined;
}

function extractOgImage(html) {
  const match = html.match(
    /<meta\s[^>]*?property\s*=\s*["']og:image["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (match) return match[1].trim();
  return undefined;
}

function extractImgUrls(html, baseUrl) {
  const urls = [];
  const regex = /<img\s[^>]*?src\s*=\s*["']([^"']+)["'][^>]*?\/?\s*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const src = match[1].trim();
    try {
      urls.push(new URL(src, baseUrl).toString());
    } catch {
      // skip
    }
  }
  return urls;
}

/** Extract data-beer-name from img tags — used by structured fixtures */
function extractImgBeerNames(html) {
  const names = {};
  // Match full img tags, then extract src and data-beer-name from each
  const imgRegex = /<img\s[^>]*?\/?\s*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const full = imgMatch[0];
    const srcMatch = full.match(/src\s*=\s*["']([^"']+)["']/i);
    const nameMatch = full.match(/data-beer-name\s*=\s*["']([^"']*)["']/i);
    if (srcMatch && nameMatch && nameMatch[1]) {
      names[srcMatch[1].trim()] = decodeEntities(nameMatch[1].trim());
    }
  }
  return names;
}

function extractCandidateBeerNames(html) {
  const names = [];
  const body = html
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, " ");

  const beerStylePattern = /\b(IPA|India\s*Pale\s*Ale|Stout|Lager|Pilsner?|Sour|Porter|Wheat|Saison)\b/i;
  const lines = body
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && l.length < 200);

  for (const line of lines) {
    if (beerStylePattern.test(line)) {
      const cleaned = decodeEntities(line).trim();
      if (!names.includes(cleaned)) names.push(cleaned);
    }
  }
  return names.slice(0, 10);
}

// ── Args ──

function parseArgs(argv) {
  const args = { seedFile: "data/raw-crawl/sources.json", limit: 20, dryRun: false, checkImages: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed-file") args.seedFile = argv[++i];
    else if (a === "--limit") args.limit = Math.min(parseInt(argv[++i]) || 20, 20);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--check-images") args.checkImages = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Raw Data Crawl Script

Usage:
  node scripts/crawl-raw-sources.mjs [options]

Options:
  --seed-file <path>    Path to sources.json (default: data/raw-crawl/sources.json)
  --limit <n>           Max URLs to crawl (default: 20, max: 20)
  --dry-run             Parse fixture HTML only, no network requests
  --check-images        Verify image URLs are accessible after crawling (slow)
  --help, -h            Show this help
`);
}

// ── Rate limiter ──

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`🍺 '🍺 原始数据爬取: seed=${args.seedFile}, limit=${args.limit}, dryRun=${args.dryRun}, checkImages=${args.checkImages}\n`);

  // Read seed sources
  const seedPath = path.resolve(ROOT, args.seedFile);
  let sources;
  try {
    sources = JSON.parse(await readFile(seedPath, "utf8"));
  } catch {
    console.error(`❌ Cannot read seed file: ${seedPath}`);
    console.error("   Make sure data/raw-crawl/sources.json exists with at least one source.");
    process.exit(1);
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    console.error("❌ sources.json is empty or not an array.");
    process.exit(1);
  }

  const allItems = [];
  const crawlErrors = [];
  const seen = new Set();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const seed of sources.slice(0, args.limit)) {
    const { name, url, description } = seed;
    console.log(`📡 Crawling: ${name} (${url})`);

    try {
      const items = await crawlUrl({ name, url, checkImages: args.checkImages, maxItemsPerUrl: 20 });
      for (const item of items) {
        const dedupKey = `${normalizeUrl(item.sourceUrl)}::${normalizeUrl(item.imageUrl)}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          allItems.push(item);
        }
      }
      console.log(`   ✅ Found ${items.length} images (${allItems.length} total unique)\n`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`   ⚠️  Failed: ${errMsg}\n`);
      // Record crawl error (not a badcase — just infrastructure failure)
      crawlErrors.push({
        sourceName: name,
        sourceUrl: url,
        errorMessage: errMsg.slice(0, 200),
        errorType: /timeout|abort/i.test(errMsg) ? "timeout"
          : /http \d+/i.test(errMsg) ? "http_error"
          : /parse|json/i.test(errMsg) ? "parse_error"
          : "unknown",
        timestamp: new Date().toISOString(),
      });
      // Try fixture fallback
      if (!args.dryRun) {
        console.log(`   🔄 Trying fixture fallback...`);
        try {
          const fixtureItems = await crawlFixtureFallback(name);
          for (const item of fixtureItems) {
            const dedupKey = `${normalizeUrl(item.sourceUrl)}::${normalizeUrl(item.imageUrl)}`;
            if (!seen.has(dedupKey)) {
              seen.add(dedupKey);
              allItems.push(item);
            }
          }
          console.log(`   ✅ Fixture found ${fixtureItems.length} items\n`);
        } catch {
          console.log(`   ⚠️  No fixture available for ${name}\n`);
        }
      }
    }

    // Rate limit: 1s between requests
    if (!args.dryRun && seed !== sources.slice(0, args.limit).at(-1)) {
      await sleep(1000);
    }
  }

  // Optionally verify image URLs are accessible
  if (args.checkImages && allItems.length > 0) {
    console.log(`\n🔍 Checking ${allItems.length} image URLs...`);
    const accessible = [];
    let checked = 0;
    for (const item of allItems) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(item.imageUrl, { method: "HEAD", signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          accessible.push(item);
        } else {
          crawlErrors.push({
            sourceName: item.sourceName,
            sourceUrl: item.sourceUrl,
            errorMessage: `image not accessible: HTTP ${res.status} for ${item.imageUrl}`,
            errorType: "http_error",
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        crawlErrors.push({
          sourceName: item.sourceName,
          sourceUrl: item.sourceUrl,
          errorMessage: `image check failed for ${item.imageUrl}`,
          errorType: "unknown",
          timestamp: new Date().toISOString(),
        });
      }
      checked++;
      if (checked % 5 === 0) process.stdout.write(`   ${checked}/${allItems.length}...\n`);
      await sleep(200); // Rate limit image checks
    }
    const dropped = allItems.length - accessible.length;
    console.log(`   ${accessible.length}/${allItems.length} accessible (${dropped} dropped)`);
    if (accessible.length > 0) {
      allItems.length = 0;
      allItems.push(...accessible);
    }
  }

  // Write output
  const rawDir = path.resolve(ROOT, "data", "raw-crawl", "raw");
  await mkdir(rawDir, { recursive: true });

  const outPath = path.join(rawDir, `crawl-${timestamp}.json`);
  const output = {
    crawledAt: new Date().toISOString(),
    sources: sources.slice(0, args.limit),
    itemCount: allItems.length,
    items: allItems,
  };
  await writeFile(outPath, JSON.stringify(output, null, 2) + "\n");

  console.log(`📦 Saved ${allItems.length} items to ${path.relative(ROOT, outPath)}`);

  // Write crawl errors if any
  if (crawlErrors.length > 0) {
    const errorDir = path.resolve(ROOT, "data", "raw-crawl", "errors");
    await mkdir(errorDir, { recursive: true });
    const errorPath = path.join(errorDir, `crawl-errors-${timestamp}.json`);
    const errorLog = {
      version: 1,
      crawledAt: new Date().toISOString(),
      errorCount: crawlErrors.length,
      errors: crawlErrors,
    };
    await writeFile(errorPath, JSON.stringify(errorLog, null, 2) + "\n");
    console.log(`⚠️  ${crawlErrors.length} crawl errors saved to ${path.relative(ROOT, errorPath)}`);
  }

  console.log(`\nDone! Run: npm run raw:tasks to generate labeling tasks.`);
}

// ── Fetch and parse a URL ──

async function crawlUrl({ name, url, checkImages, maxItemsPerUrl }) {
  const items = [];
  let html;

  // Handle fixture:// protocol
  if (url.startsWith("fixture://")) {
    const fixtureName = url.replace("fixture://", "");
    const fixturePath = path.resolve(ROOT, "data", "raw-crawl", "fixtures", `${fixtureName}.html`);
    try {
      html = await readFile(fixturePath, "utf8");
    } catch {
      throw new Error(`Fixture not found: ${fixturePath}`);
    }
  } else {
    // Real HTTP fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "BeerLens-RawCrawler/1.0 (research bot; limit 20)" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      html = text.slice(0, 500_000); // Limit to 500KB
    } finally {
      clearTimeout(timeout);
    }
  }

  const pageTitle = extractOgTitle(html);
  const pageDescription = extractOgDescription(html);
  const ogImage = extractOgImage(html);
  const imgUrls = extractImgUrls(html, url.startsWith("fixture://") ? "https://example.com" : url);
  const imgBeerNames = extractImgBeerNames(html);
  const candidateBeerNames = extractCandidateBeerNames(html);

  // Build crawl items for each image
  const now = new Date().toISOString();

  // First, try the og:image
  if (ogImage) {
    // Resolve relative og:image
    let resolvedOg = ogImage;
    try {
      resolvedOg = new URL(ogImage, url.startsWith("fixture://") ? "https://example.com" : url).toString();
    } catch { /* keep as-is */ }
    const ogBeerName = imgBeerNames[resolvedOg] || candidateBeerNames[0] || undefined;
    items.push({
      sourceName: name,
      sourceUrl: url,
      imageUrl: resolvedOg,
      pageTitle,
      pageDescription,
      candidateBeerName: ogBeerName,
      crawledAt: now,
    });
  }

  // Then other img tags
  for (const imgUrl of imgUrls) {
    // Skip tiny icons, tracking pixels
    if (/favicon|pixel|tracking|1x1|spacer|blank|icon-16|icon-32/i.test(imgUrl)) continue;
    const imageCount = items.filter((i) => i.imageUrl === imgUrl).length;
    if (imageCount > 0) continue; // Already added

    const beerName = imgBeerNames[imgUrl]
      || candidateBeerNames[Math.min(items.length, candidateBeerNames.length - 1)]
      || undefined;
    items.push({
      sourceName: name,
      sourceUrl: url,
      imageUrl: imgUrl,
      pageTitle,
      pageDescription,
      candidateBeerName: beerName,
      crawledAt: now,
    });
  }

  // If no images found, still create one item with the page itself
  if (items.length === 0) {
    items.push({
      sourceName: name,
      sourceUrl: url,
      imageUrl: url, // Use page URL as imageUrl when no images found
      pageTitle,
      pageDescription,
      candidateBeerName: candidateBeerNames[0] || undefined,
      crawledAt: now,
    });
  }

  return items.slice(0, maxItemsPerUrl);
}

// ── Fixture fallback ──

async function crawlFixtureFallback(sourceName) {
  const fixturesDir = path.resolve(ROOT, "data", "raw-crawl", "fixtures");
  try {
    const files = await readdir(fixturesDir);
    const htmlFiles = files.filter((f) => f.endsWith(".html"));
    const allItems = [];
    for (const file of htmlFiles.slice(0, 1)) { // Only use first fixture as fallback
      const html = await readFile(path.join(fixturesDir, file), "utf8");
      const items = await crawlUrl({
        name: `fallback-${sourceName}`,
        url: `fixture://${file.replace(".html", "")}`,
        checkImages: false,
        maxItemsPerUrl: 5,
      });
      allItems.push(...items);
    }
    return allItems;
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
