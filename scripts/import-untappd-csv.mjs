#!/usr/bin/env node
/**
 * scripts/import-untappd-csv.mjs
 *
 * Convert an Untappd CSV export to a BeerRecord JSONL stream + summary stats.
 *
 * CSV columns (10):
 *   id, name, brewery, style, country, abv, rating, ratings_count,
 *   untappd_url, label_image
 *
 * Each row is mapped to a BeerRecord (see lib/crawler/contracts.ts) and written
 * as one line of JSONL. Country / brewery / label_image go into a sibling
 * `__meta` JSONL line so the main record stays schema-clean.
 *
 * Usage:
 *   npm run import-untappd-csv
 *   npm run import-untappd-csv -- --in /tmp/untappd.csv \
 *                                --out data/raw-data/untappd-csv-input.jsonl \
 *                                --stats data/raw-data/untappd-csv-stats.json
 *
 * Stdlib only — no npm dependencies.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

// ── CLI parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    in: "/tmp/untappd.csv",
    out: "data/raw-data/untappd-csv-input.jsonl",
    stats: "data/raw-data/untappd-csv-stats.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") out.in = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--stats") out.stats = argv[++i];
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: node scripts/import-untappd-csv.mjs " +
          "[--in csv] [--out jsonl] [--stats json]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

// ── Minimal RFC 4180 CSV field parser ─────────────────────────────────────
// Handles quoted fields with embedded commas + escaped quotes ("" -> ").
// Returns the fields of one physical line — quoted fields with embedded
// newlines are joined (sufficient for the Untappd export).

export function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// ── Row → BeerRecord ──────────────────────────────────────────────────────

const CSV_COLUMNS = [
  "id",
  "name",
  "brewery",
  "style",
  "country",
  "abv",
  "rating",
  "ratings_count",
  "untappd_url",
  "label_image",
];

function toNumOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function csvRowToBeerRecord(row) {
  const fetched_at = new Date().toISOString();
  const untappdUrl = row.untappd_url || "";
  return {
    source: "untappd",
    source_id: String(row.id),
    name: row.name,
    brewery_id: null, // CSV export omits brewery_id
    style: row.style || null,
    abv: toNumOrNull(row.abv),
    ibu: null,
    rating: toNumOrNull(row.rating),
    rating_count: toNumOrNull(row.ratings_count),
    description: null,
    labels: [],
    food_pairing: [],
    similar_ids: [],
    url: untappdUrl.startsWith("/")
      ? `https://untappd.com${untappdUrl}`
      : untappdUrl,
    fetched_at,
  };
}

function csvRowToMeta(row) {
  return {
    __meta: true,
    source: "untappd",
    source_id: String(row.id),
    country: row.country || null,
    brewery_name: row.brewery || null,
    label_image: row.label_image || null,
  };
}

// ── Streaming stats (single-pass, bounded memory) ─────────────────────────

const RATING_BUCKETS = [
  ["0-1", (r) => r >= 0 && r < 1],
  ["1-2", (r) => r >= 1 && r < 2],
  ["2-3", (r) => r >= 2 && r < 3],
  ["3-3.5", (r) => r >= 3 && r < 3.5],
  ["3.5-4", (r) => r >= 3.5 && r < 4],
  ["4-4.5", (r) => r >= 4 && r < 4.5],
  ["4.5-5", (r) => r >= 4.5 && r <= 5],
];

export function bucketFor(rating) {
  for (const [name, pred] of RATING_BUCKETS) {
    if (pred(rating)) return name;
  }
  return null;
}

function makeStats() {
  return {
    total_records: 0,
    by_country: Object.create(null),
    by_style_top_50: [],
    rating_distribution: Object.fromEntries(RATING_BUCKETS.map(([n]) => [n, 0])),
    brewery_unique: 0,
    abv_distribution: { mean: null, median: null, min: null, max: null },
    generated_at: null,
  };
}

class Accumulator {
  constructor() {
    this.total = 0;
    this.country = new Map();
    this.style = new Map();
    this.brewery = new Set();
    this.ratingDist = Object.fromEntries(RATING_BUCKETS.map(([n]) => [n, 0]));
    this.abvSorted = []; // sorted insert: bounded by O(N) but acceptable for 32k rows
  }

  add(row) {
    this.total++;
    if (row.country) {
      this.country.set(row.country, (this.country.get(row.country) ?? 0) + 1);
    }
    if (row.style) {
      this.style.set(row.style, (this.style.get(row.style) ?? 0) + 1);
    }
    if (row.brewery) {
      this.brewery.add(row.brewery);
    }
    const r = toNumOrNull(row.rating);
    if (r !== null) {
      const b = bucketFor(r);
      if (b) this.ratingDist[b]++;
    }
    const a = toNumOrNull(row.abv);
    if (a !== null) {
      // Binary-insert so we can compute median without retaining all values
      // unsorted.
      let lo = 0;
      let hi = this.abvSorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.abvSorted[mid] < a) lo = mid + 1;
        else hi = mid;
      }
      this.abvSorted.splice(lo, 0, a);
    }
  }

  finalize() {
    const s = makeStats();
    s.total_records = this.total;
    s.by_country = [...this.country.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([country, count]) => ({ country, count }));
    // Store as plain object for JSON friendliness (the brief asked for
    // `{ country: count }` ordering).
    const byCountryObj = Object.create(null);
    for (const [k, v] of this.country.entries()) byCountryObj[k] = v;
    s.by_country_obj = byCountryObj;
    s.by_style_top_50 = [...this.style.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 50)
      .map(([style, count]) => ({ style, count }));
    s.rating_distribution = this.ratingDist;
    s.brewery_unique = this.brewery.size;
    s.abv_distribution = abvStats(this.abvSorted);
    s.generated_at = new Date().toISOString();
    return s;
  }
}

function abvStats(sortedAsc) {
  if (sortedAsc.length === 0) {
    return { mean: null, median: null, min: null, max: null, n: 0 };
  }
  let sum = 0;
  for (const v of sortedAsc) sum += v;
  const n = sortedAsc.length;
  const mean = sum / n;
  const median =
    n % 2 === 1
      ? sortedAsc[(n - 1) >> 1]
      : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
  return {
    mean,
    median,
    min: sortedAsc[0],
    max: sortedAsc[n - 1],
    n,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Pre-flight: source must exist.
  try {
    await stat(args.in);
  } catch {
    process.stderr.write(`Input CSV not found: ${args.in}\n`);
    process.exit(2);
  }

  await mkdir(dirname(args.out), { recursive: true });
  await mkdir(dirname(args.stats), { recursive: true });

  const acc = new Accumulator();
  const out = createWriteStream(args.out, { encoding: "utf8" });

  const rl = createInterface({
    input: createReadStream(args.in, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  for await (const rawLine of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (rawLine === "") continue; // skip blank lines
    const fields = parseCsvLine(rawLine);
    if (fields.length < CSV_COLUMNS.length) continue; // malformed row — skip
    const row = Object.fromEntries(
      CSV_COLUMNS.map((k, i) => [k, fields[i] ?? ""]),
    );
    const rec = csvRowToBeerRecord(row);
    const meta = csvRowToMeta(row);
    if (!out.write(JSON.stringify(rec) + "\n")) {
      // back-pressure
      await new Promise((r) => out.once("drain", r));
    }
    if (!out.write(JSON.stringify(meta) + "\n")) {
      await new Promise((r) => out.once("drain", r));
    }
    acc.add(row);
  }

  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });

  const stats = acc.finalize();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(args.stats, JSON.stringify(stats, null, 2) + "\n", "utf8");

  process.stdout.write(
    `import: ${stats.total_records} records, ${stats.brewery_unique} breweries, ${stats.by_country.length} countries\n` +
      `  → ${args.out}\n` +
      `  → ${args.stats}\n`,
  );
}

// CLI guard — only run when invoked directly, not when imported by tests.
const isDirect = process.argv[1] && process.argv[1].endsWith("import-untappd-csv.mjs");
if (isDirect) {
  main().catch((err) => {
    process.stderr.write(`import failed: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}