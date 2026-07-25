#!/usr/bin/env node
/**
 * beer-lens CLI — query Chinese craft beer data from seed JSON.
 *
 * Usage:
 *   npm run cli -- --help
 *   npm run cli -- --name 青岛
 *   npm run cli -- --style IPA
 *   npm run cli -- --brewery 京A
 *   npm run cli -- --style IPA --json
 *   npm run cli -- --list-styles
 *   npm run cli -- --list-breweries
 *
 * No DB/network dependency. Reads directly from data/chinese-craft-beers.json.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_PATH = join(ROOT, "data", "chinese-craft-beers.json");

// ── Help ────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
🍺 beer-lens — 中国精酿啤酒查询工具

用法:
  npx beer-lens [选项]

查询模式:
  --name, -n <关键词>      按啤酒名称搜索（支持中英文模糊匹配）
  --style, -s <风格>        按风格搜索（如 IPA, Stout, Lager）
  --brewery, -b <酒厂>      按酒厂搜索（支持中英文名称）

输出选项:
  --json                    以 JSON 格式输出（对 | jq 友好）
  --limit, -l <数量>        限制返回数量（默认 20）

辅助命令:
  --help, -h                显示本帮助
  --list-styles             列出所有风格
  --list-breweries          列出所有酒厂
  --stats                   显示数据概览

示例:
  npx beer-lens --name 青岛
  npx beer-lens --style IPA --json
  npx beer-lens --brewery 京A
  npx beer-lens --style IPA --brewery "Master Gao" --json
  npx beer-lens --stats
`);
}

// ── Data loading ────────────────────────────────────────────────────────

let _cache = null;

function loadBeers() {
  if (_cache) return _cache;
  try {
    const raw = readFileSync(DATA_PATH, "utf8");
    _cache = JSON.parse(raw);
  } catch {
    console.error("❌ 无法读取数据文件:", DATA_PATH);
    process.exit(1);
  }
  return _cache;
}

// ── Search helpers ──────────────────────────────────────────────────────

function fuzzyMatch(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();

  // Exact match
  if (t === q) return 1;
  // Contains
  if (t.includes(q)) return 0.9;
  // Each query word must appear
  const qWords = q.split(/\s+/);
  if (qWords.every((w) => t.includes(w))) return 0.7;
  // Abbreviation match (last resort): all query chars appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi === q.length) return 0.6;
  return 0;
}

function styleMatch(style, query) {
  // Style matching is stricter — must match at word boundaries to avoid
  // "American Pale Ale" matching "IPA"
  const s = style.toLowerCase();
  const q = query.toLowerCase().trim();

  if (s === q) return 1;
  if (s.includes(q)) return 0.9;
  // Word boundary match: at least one word in the style must contain the query word
  const sWords = s.split(/\s+/);
  const qWords = q.split(/\s+/);
  if (qWords.every((qw) => sWords.some((sw) => sw.includes(qw)))) return 0.7;
  // Exact match after stripping common prefixes
  const sClean = s.replace(/^(american|belgian|czech|english|german|new)\s+/i, "");
  if (sClean.includes(q)) return 0.65;
  return 0;
}

function searchBeers(beers, { name, style, brewery, limit = 20 }) {
  let results = beers.map((b) => {
    let score = 0;
    let matches = [];

    if (name) {
      const s =
        fuzzyMatch(b.name, name) * 0.4 +
        fuzzyMatch(b.chinese_name || "", name) * 0.4 +
        fuzzyMatch(b.brewery || "", name) * 0.1 +
        fuzzyMatch(b.chinese_brewery || "", name) * 0.1;
      if (s > 0) {
        score += s;
        matches.push("name");
      }
    }

    if (style) {
      const s = styleMatch(b.style, style);
      if (s > 0) {
        score += s;
        matches.push("style");
      }
    }

    if (brewery) {
      const s =
        fuzzyMatch(b.brewery, brewery) * 0.6 +
        fuzzyMatch(b.chinese_brewery || "", brewery) * 0.4;
      if (s > 0) {
        score += s;
        matches.push("brewery");
      }
    }

    return { ...b, _score: score, _matches: matches };
  });

  // If no filters, return all
  const hasFilter = name || style || brewery;
  if (!hasFilter) {
    results = results.map((b) => ({ ...b, _score: 1 }));
  } else {
    // Require ALL specified filters to match (AND logic)
    const requiredFilters = [];
    if (name) requiredFilters.push("name");
    if (style) requiredFilters.push("style");
    if (brewery) requiredFilters.push("brewery");
    results = results.filter((b) =>
      requiredFilters.every((f) => b._matches.includes(f))
    );
  }

  // Sort by score desc, then rating desc
  results.sort((a, b) => b._score - a._score || b.rating - a.rating);
  return results.slice(0, limit);
}

// ── Output formatters ───────────────────────────────────────────────────

function formatText(results, queryDesc) {
  if (results.length === 0) {
    console.log(`\n😕 没有找到匹配的啤酒。${queryDesc ? `查询: ${queryDesc}` : ""}`);
    return;
  }

  console.log(`\n🍺 找到 ${results.length} 款啤酒${queryDesc ? ` | ${queryDesc}` : ""}`);
  console.log("─".repeat(78));

  const header = [
    padRight("名称", 28),
    padRight("酒厂", 22),
    padRight("风格", 20),
    padLeft("ABV", 5),
    padLeft("评分", 6),
    padLeft("评论数", 8),
  ].join(" ");
  console.log(header);
  console.log("─".repeat(78));

  for (const b of results) {
    const row = [
      padRight(b.chinese_name || b.name, 28),
      padRight(b.chinese_brewery || b.brewery, 22),
      padRight(b.style || "-", 20),
      padLeft(String(b.abv ?? "-") + "%", 5),
      padLeft(String(b.rating ?? "-"), 6),
      padLeft(formatNumber(b.ratings_count ?? 0), 8),
    ].join(" ");
    console.log(row);
  }
  console.log("─".repeat(78));
}

function formatJSON(results, queryDesc) {
  const output = results.map((b) => ({
    name: b.name,
    chinese_name: b.chinese_name || null,
    brewery: b.brewery,
    chinese_brewery: b.chinese_brewery || null,
    style: b.style,
    abv: b.abv,
    rating: b.rating,
    ratings_count: b.ratings_count,
    country: b.country,
  }));
  console.log(JSON.stringify(output, null, 2));
}

function padRight(s, len) {
  const str = String(s);
  const visible = [...str].length;
  if (visible >= len) return str.slice(0, len);
  return str + " ".repeat(len - visible);
}

function padLeft(s, len) {
  const str = String(s);
  const visible = [...str].length;
  if (visible >= len) return str.slice(0, len);
  return " ".repeat(len - visible) + str;
}

function formatNumber(n) {
  if (n >= 10000) return (n / 1000).toFixed(1) + "k";
  if (n >= 1000) return (n / 1000).toFixed(2) + "k";
  return String(n);
}

// ── List commands ───────────────────────────────────────────────────────

function listStyles(beers) {
  const styles = {};
  for (const b of beers) {
    const s = b.style || "Unknown";
    styles[s] = (styles[s] || 0) + 1;
  }
  const sorted = Object.entries(styles).sort((a, b) => b[1] - a[1]);
  console.log("\n🍺 啤酒风格 (共 " + sorted.length + " 种):\n");
  for (const [style, count] of sorted) {
    console.log(`  ${padRight(style, 28)} ${count} 款`);
  }
}

function listBreweries(beers) {
  const breweries = {};
  for (const b of beers) {
    const key = b.chinese_brewery ? `${b.brewery} / ${b.chinese_brewery}` : b.brewery;
    breweries[key] = (breweries[key] || 0) + 1;
  }
  const sorted = Object.entries(breweries).sort((a, b) => b[1] - a[1]);
  console.log("\n🏭 酒厂 (共 " + sorted.length + " 家):\n");
  for (const [brewery, count] of sorted) {
    console.log(`  ${padRight(brewery, 48)} ${count} 款`);
  }
}

function showStats(beers) {
  const total = beers.length;
  const styles = new Set(beers.map((b) => b.style));
  const brewKeys = new Set(beers.map((b) => b.brewery));
  const avgRating = (beers.reduce((s, b) => s + (b.rating || 0), 0) / total).toFixed(2);
  const avgABV = (beers.reduce((s, b) => s + (b.abv || 0), 0) / total).toFixed(1);

  console.log(`
📊 Beer Lens — 中文精酿数据概览
${"─".repeat(40)}
  啤酒总数:    ${total}
  酒厂数量:    ${brewKeys.size}
  风格种类:    ${styles.size}
  平均评分:    ${avgRating}
  平均 ABV:    ${avgABV}%
  数据来源:    data/chinese-craft-beers.json
  数据国家:    China
`);
}

// ── CLI parser ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { limit: 20 };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--name":
      case "-n":
        opts.name = args[++i] || "";
        break;
      case "--style":
      case "-s":
        opts.style = args[++i] || "";
        break;
      case "--brewery":
      case "-b":
        opts.brewery = args[++i] || "";
        break;
      case "--json":
        opts.json = true;
        break;
      case "--limit":
      case "-l":
        opts.limit = parseInt(args[++i] || "20", 10);
        break;
      case "--list-styles":
        opts.listStyles = true;
        break;
      case "--list-breweries":
        opts.listBreweries = true;
        break;
      case "--stats":
        opts.stats = true;
        break;
      default:
        if (!a.startsWith("-")) {
          positional.push(a);
        }
    }
  }

  // If positional args given but no mode specified, treat first as name search
  if (positional.length > 0 && !opts.name && !opts.style && !opts.brewery && !opts.help && !opts.listStyles && !opts.listBreweries && !opts.stats) {
    opts.name = positional.join(" ");
  }

  return opts;
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    return;
  }

  const beers = loadBeers();

  // Discovery commands
  if (opts.listStyles) {
    listStyles(beers);
    return;
  }
  if (opts.listBreweries) {
    listBreweries(beers);
    return;
  }
  if (opts.stats) {
    showStats(beers);
    return;
  }

  // Build query description for text output
  const filters = [];
  if (opts.name) filters.push(`名称: ${opts.name}`);
  if (opts.style) filters.push(`风格: ${opts.style}`);
  if (opts.brewery) filters.push(`酒厂: ${opts.brewery}`);
  const queryDesc = filters.join(", ") || "全部";

  // Search
  const results = searchBeers(beers, opts);

  // Output
  if (opts.json) {
    formatJSON(results.includes ? results : results, queryDesc);
  } else {
    formatText(results, queryDesc);
  }
}

main();
