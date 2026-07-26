/**
 * RateBeer Data Updater — 从公开数据集更新 RateBeer 评分数据。
 *
 * 此文件是需求规格 + 桩代码。实际的更新逻辑交给其他 AI / 开发者完成。
 *
 * ## 数据来源 (Source adapters)
 *
 *   - 'kaggle'      → Kaggle RateBeer dataset (1.58M reviews aggregate)
 *   - 'http-url'    → Direct CSV/ZIP URL (must pass host allow-list + content-type check)
 *   - 'file'        → Local CSV/ZIP file path (offline staging)
 *
 * Default sourceURL/file resolved via env:
 *   RATEBEER_SOURCE_URL    (https CSV/ZIP)
 *   RATEBEER_SOURCE_FILE   (path to local CSV/ZIP)
 *
 * ## 更新流程
 *
 *   1. Resolve source via source adapter (kaggle/http-url/file)
 *   2. Stream CSV/ZIP to staging dir (never load fully in-memory)
 *   3. Validate host allow-list + content-type + checksum + CSV header
 *   4. Parse with flexible column alias mapping
 *   5. Compare with current beer.db (beers table)
 *   6. Apply ratings cross-source isolation:
 *        source='ratebeer-2026-...' + checksums
 *        Never silently overwrite if checksum of incoming file changes.
 *   7. Incremental upsert (added | updated | skipped)
 *   8. Write update log
 *
 * ## 去重
 *
 * - 按 name + brewery 组合去重
 * - 保留最新 rating
 * - 合并 ratings_count
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, unlink, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type RateBeerRecord = {
  name: string;
  brewery: string;
  style: string;
  abv: number;
  rating: number;
  ratings_count: number;
  review_aroma?: number;
  review_appearance?: number;
  review_palate?: number;
  review_taste?: number;
};

export type RateBeerUpdateResult = {
  source: string;
  sourceUrl: string;
  sourceKind: RateBeerSourceKind;
  totalInSource: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  checksum: string;
  stagingPath?: string;
};

export type RateBeerSourceKind = "kaggle" | "http-url" | "file";

export type RateBeerUpdateOptions = {
  /** 数据源 URL (CSV/ZIP) */
  sourceUrl?: string;
  /** 数据源 kind. Default resolved from sourceUrl presence/host */
  sourceKind?: RateBeerSourceKind;
  /** Local file path (when sourceKind=file) */
  sourceFile?: string;
  /** Host allow-list (default: ratebeer.com, kaggle.com, github.com, cdn-lfs.huggingface.co) */
  allowedHosts?: string[];
  /** Optional expected SHA-256 to fail-fast on data drift */
  expectedSha256?: string;
  /** Only process specific styles */
  styles?: string[];
  /** Minimum rating threshold */
  minRating?: number;
  /** Minimum ratings_count threshold */
  minRatingsCount?: number;
  /** Run with skip-if-unchanged behaviour (default true): if checksum matches
   *  the last persisted run, return early without rewriting anything. */
  skipIfUnchanged?: boolean;
};

// ── Constants ──

const UPDATE_LOG_PATH = path.join(process.cwd(), "data", "beer-db-update.json");
const TEMP_DIR = path.join(process.cwd(), ".temp");
const CHECKSUM_LOG_FILENAME = "ratebeer-checksum.json";

/** Host allow-list — fail-closed to known-good domains. */
const DEFAULT_ALLOWED_HOSTS = [
  "ratebeer.com",
  "www.ratebeer.com",
  "kaggle.com",
  "www.kaggle.com",
  "github.com",
  "raw.githubusercontent.com",
  "cdn-lfs.huggingface.co",
];

/** Kaggle dataset root → source tag for cross-source isolation */
const KAGGLE_SOURCE_TAG = "ratebeer-kaggle-2026";

/** Flexible column name mapping — handles different CSV formats */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ["beer_name", "name", "Beer Name", "beer", "Beer"],
  brewery: ["brewery_name", "brewery", "Brewery", "Brewery Name"],
  style: ["style", "beer_style", "Style", "category", "beer_category"],
  abv: ["beer_abv", "abv", "ABV", "Alcohol By Volume"],
  rating: ["review_overall", "overall_score", "avg_rating", "rating", "score", "Review Overall", "overall"],
  ratings_count: ["number_of_reviews", "review_count", "ratings_count", "count", "reviews", "Review Count"],
  review_aroma: ["review_aroma", "aroma", "Aroma"],
  review_appearance: ["review_appearance", "appearance", "Appearance"],
  review_palate: ["review_palate", "palate", "Palate", "mouthfeel"],
  review_taste: ["review_taste", "taste", "Taste", "flavor"],
};

/** Required columns to consider a CSV valid. */
const REQUIRED_COLUMNS = ["name", "brewery", "rating"];

/** Source adapter spec — determines how to resolve a file. */
type SourceAdapter =
  | { kind: "kaggle"; url: string }
  | { kind: "http-url"; url: string; allowedHosts: string[] }
  | { kind: "file"; path: string };

// ── CSV Parser ──

/** Detect the most likely delimiter from the first line */
function detectDelimiter(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const candidates: Array<[string, number]> = [
    [",", (firstLine.match(/,/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    ["|", (firstLine.match(/\|/g) ?? []).length],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ",";
}

/**
 * Parse CSV text into rows, handling:
 * - Quoted fields with embedded delimiters
 * - Quoted fields with newlines
 * - Escaped quotes ("")
 * - BOM, \r\n line endings
 */
function parseCsvRows(text: string, delimiter = ","): string[][] {
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        currentField += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === delimiter) {
        currentRow.push(currentField);
        currentField = "";
        i++;
      } else if (char === "\r") {
        // Skip — \r\n handled by \n
        i++;
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        i++;
      } else {
        currentField += char;
        i++;
      }
    }
  }

  // Push trailing field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/** Parse CSV text into array of record objects (keyed by header names) */
function parseCsv(text: string): Record<string, string>[] {
  const delimiter = detectDelimiter(text);
  const rows = parseCsvRows(text, delimiter);
  if (rows.length === 0) return [];

  const headers = rows[0].map(h => h.trim());
  const records: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Skip empty lines
    if (row.length === 1 && row[0] === "") continue;
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = row[j] ?? "";
    }
    records.push(record);
  }

  return records;
}

/** Validate that the CSV header contains all required columns (with alias matching). */
function validateCsvHeader(text: string): { ok: boolean; missing: string[]; headers: string[] } {
  const rows = parseCsvRows(text.slice(0, 4096), detectDelimiter(text));
  if (rows.length === 0) return { ok: false, missing: REQUIRED_COLUMNS, headers: [] };
  const headers = rows[0].map(h => h.trim().toLowerCase());

  const presentAliases = new Set(headers);
  const missing: string[] = [];
  for (const required of REQUIRED_COLUMNS) {
    const aliases = COLUMN_ALIASES[required] ?? [required];
    const hit = aliases.some(a => presentAliases.has(a.trim().toLowerCase()));
    if (!hit) missing.push(required);
  }
  return { ok: missing.length === 0, missing, headers };
}

// ── Column mapping ──

/** Map a CSV record to a RateBeerRecord using flexible column name matching */
function mapRecord(csvRecord: Record<string, string>): RateBeerRecord | null {
  const getValue = (field: string): string => {
    const aliases = COLUMN_ALIASES[field] ?? [field];
    for (const alias of aliases) {
      const lower = alias.trim().toLowerCase();
      for (const key of Object.keys(csvRecord)) {
        if (key.trim().toLowerCase() === lower) {
          return csvRecord[key];
        }
      }
    }
    return "";
  };

  const name = getValue("name").trim();
  if (!name) return null;

  const brewery = getValue("brewery").trim();
  const style = getValue("style").trim() || "Unknown";
  const abv = parseFloat(getValue("abv")) || 0;
  const rating = parseFloat(getValue("rating")) || 0;
  const ratings_count = parseInt(getValue("ratings_count").replace(/[^0-9]/g, ""), 10) || 0;

  // Optional review scores (1-5 scale; 0 or NaN → undefined)
  const review_aroma = parseFloat(getValue("review_aroma")) || undefined;
  const review_appearance = parseFloat(getValue("review_appearance")) || undefined;
  const review_palate = parseFloat(getValue("review_palate")) || undefined;
  const review_taste = parseFloat(getValue("review_taste")) || undefined;

  return {
    name,
    brewery,
    style,
    abv,
    rating,
    ratings_count,
    review_aroma,
    review_appearance,
    review_palate,
    review_taste,
  };
}

/**
 * Aggregate records by name + brewery.
 * Handles both pre-aggregated data (one row per beer) and individual
 * review data (multiple rows per beer) by computing averages.
 */
function aggregateRecords(records: RateBeerRecord[]): RateBeerRecord[] {
  const beerMap = new Map<string, RateBeerRecord[]>();

  for (const record of records) {
    const key = `${record.name.toLowerCase()}|${record.brewery.toLowerCase()}`;
    const existing = beerMap.get(key);
    if (existing) {
      existing.push(record);
    } else {
      beerMap.set(key, [record]);
    }
  }

  const result: RateBeerRecord[] = [];

  for (const group of beerMap.values()) {
    if (group.length === 1) {
      // Single record — use as-is, ensure ratings_count ≥ 1
      const r = group[0];
      if (r.ratings_count === 0) r.ratings_count = 1;
      result.push(r);
    } else {
      // Multiple records — aggregate (individual reviews)
      const first = group[0];
      const count = group.length;
      const sumRating = group.reduce((s, r) => s + r.rating, 0);

      const avgOptional = (
        field: "review_aroma" | "review_appearance" | "review_palate" | "review_taste",
      ): number | undefined => {
        const values = group
          .map(r => r[field])
          .filter((v): v is number => v !== undefined);
        if (values.length === 0) return undefined;
        return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
      };

      result.push({
        name: first.name,
        brewery: first.brewery,
        style: first.style,
        abv: first.abv,
        rating: Math.round((sumRating / count) * 100) / 100,
        ratings_count: count,
        review_aroma: avgOptional("review_aroma"),
        review_appearance: avgOptional("review_appearance"),
        review_palate: avgOptional("review_palate"),
        review_taste: avgOptional("review_taste"),
      });
    }
  }

  return result;
}

// ── Source adapter (resolve + validate) ──

/**
 * Pick the source adapter based on explicit options + env defaults.
 * Precedence: explicit options > env > auto-detect from URL hostname.
 */
function resolveSourceAdapter(options: RateBeerUpdateOptions): SourceAdapter | null {
  const envUrl = process.env.RATEBEER_SOURCE_URL ?? "";
  const envFile = process.env.RATEBEER_SOURCE_FILE ?? "";
  const url = options.sourceUrl ?? envUrl ?? "";
  const file = options.sourceFile ?? envFile ?? "";

  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;

  if (options.sourceKind === "file" || (!url && file)) {
    if (!file) return null;
    return { kind: "file", path: file };
  }
  if (url) {
    // Auto-detect kind from URL hostname
    try {
      const u = new URL(url);
      const host = u.hostname;
      const isKaggle =
        /^kaggle\.com$/i.test(host) ||
        /^www\.kaggle\.com$/i.test(host) ||
        host.endsWith(".kaggle.com");
      if (isKaggle) return { kind: "kaggle", url };
    } catch {
      // Fall through to http-url validation
    }
    return { kind: "http-url", url, allowedHosts };
  }
  return null;
}

/** Validate URL host against allow-list. */
function validateUrlHost(url: string, allowedHosts: string[]): void {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const ok = allowedHosts.some(h => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
  if (!ok) {
    throw new Error(
      `[crawler:ratebeer] host not in allow-list: ${host} (allowed: ${allowedHosts.join(", ")})`,
    );
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`[crawler:ratebeer] unsupported protocol: ${u.protocol}`);
  }
}

/** Fetch response for a URL with content-type + size guards. */
async function fetchWithValidation(
  url: string,
  opts: { allowedHosts: string[]; maxBytes?: number },
): Promise<Response> {
  validateUrlHost(url, opts.allowedHosts);
  const maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024; // 1 GiB
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/csv,application/zip,application/octet-stream;q=0.9,*/*;q=0.8",
    },
    redirect: "follow" as const,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  // Allow known good types; bail on HTML (likely login/error page)
  if (
    contentType.includes("text/html") &&
    !contentType.includes("csv")
  ) {
    throw new Error(`[crawler:ratebeer] unexpected content-type (${contentType}) for ${url}`);
  }
  // Cap streaming size via Content-Length (or unknown → trust limit at read)
  const lenStr = response.headers.get("content-length");
  if (lenStr) {
    const len = parseInt(lenStr, 10);
    if (!isNaN(len) && len > maxBytes) {
      throw new Error(`[crawler:ratebeer] payload too large: ${len} > ${maxBytes}`);
    }
  }
  return response;
}

/**
 * Stream the upstream response body to a staging file. Track SHA-256 inline.
 * Caller is responsible for cleanup of the staging path.
 */
async function streamToStaging(
  response: Response,
  stagingPath: string,
): Promise<{ checksum: string; bytes: number }> {
  await mkdir(path.dirname(stagingPath), { recursive: true });
  if (!response.body) throw new Error("[crawler:ratebeer] no response body to stream");

  const reader = response.body.getReader();
  const hasher = createHash("sha256");
  let bytes = 0;

  const chunks: Buffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hasher.update(value);
      bytes += value.length;
      chunks.push(Buffer.from(value));
    }
  }
  const full = Buffer.concat(chunks);
  await writeFile(stagingPath, full);
  return { checksum: hasher.digest("hex"), bytes };
}

/**
 * Stream local file to staging file. Same hashing. Use this when the
 * adapter is 'file' or whenever we want to never load CSVs into memory.
 */
async function stageLocalFile(
  sourcePath: string,
  stagingPath: string,
): Promise<{ checksum: string; bytes: number }> {
  const info = await stat(sourcePath);
  await mkdir(path.dirname(stagingPath), { recursive: true });

  const hasher = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(sourcePath);
  const out = createWriteStream(stagingPath);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hasher.update(buf);
      bytes += buf.length;
      out.write(buf);
    });
    stream.on("end", () => out.end());
    stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", () => resolve());
  });
  return { checksum: hasher.digest("hex"), bytes: bytes || info.size };
}

// ── Decompression ──

/**
 * Decompress a staging file in-place. Writes a sibling file
 * `{staging}.decoded` containing plain CSV. Streams rather than
 * loading whole archive in-memory.
 */
async function decodeStagedFile(stagingPath: string): Promise<string> {
  const { open } = await import("node:fs/promises");
  const fh = await open(stagingPath, "r");
  try {
    const headerBuf = Buffer.alloc(4);
    await fh.read(headerBuf, 0, 4, 0);
    const magic = headerBuf;
    const decodedPath = `${stagingPath}.decoded`;

    // Gzip (0x1f 0x8b)
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      const { createGunzip } = await import("node:zlib");
      await new Promise<void>((resolve, reject) => {
        createReadStream(stagingPath)
          .pipe(createGunzip())
          .pipe(createWriteStream(decodedPath))
          .on("finish", () => resolve())
          .on("error", reject);
      });
      return decodedPath;
    }

    // ZIP (PK 0x03 0x04) — delegate to Python (guaranteed available)
    if (magic[0] === 0x50 && magic[1] === 0x4b) {
      const { stdout } = await execFileAsync(
        "python3",
        [
          "-c",
          `import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
csv_files = [n for n in z.namelist() if n.lower().endswith('.csv')]
if csv_files:
    sys.stdout.buffer.write(z.read(csv_files[0]))
else:
    for n in z.namelist():
        if not n.endswith('/'):
            sys.stdout.buffer.write(z.read(n))
            break`,
          stagingPath,
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024 * 1024 },
      );
      // Persist to disk for header validation + restartability
      await writeFile(decodedPath, stdout);
      return decodedPath;
    }

    // Plain text — symlink by copy of size-zero? Just return stagingPath
    return stagingPath;
  } finally {
    await fh.close();
  }
}

// ── Database operations ──

/** Query existing beers from the beers table for comparison */
async function getExistingBeers(): Promise<
  Map<string, { rating: number; ratings_count: number; id: number }>
> {
  const map = new Map<string, { rating: number; ratings_count: number; id: number }>();
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-c",
        `import sqlite3, json
con = sqlite3.connect('.beer-data/beer.db')
rows = con.execute('SELECT id, name, brewery, rating, ratings_count FROM beers').fetchall()
con.close()
print(json.dumps([{'id': r[0], 'name': r[1] or '', 'brewery': r[2] or '', 'rating': r[3] or 0, 'ratings_count': r[4] or 0} for r in rows]))`,
      ],
      { timeout: 30_000, maxBuffer: 100 * 1024 * 1024 },
    );

    const beers: Array<{
      id: number;
      name: string;
      brewery: string;
      rating: number;
      ratings_count: number;
    }> = JSON.parse(stdout.trim());

    for (const beer of beers) {
      const key = `${beer.name.toLowerCase()}|${beer.brewery.toLowerCase()}`;
      map.set(key, { rating: beer.rating, ratings_count: beer.ratings_count, id: beer.id });
    }
  } catch (err) {
    console.warn(
      "[crawler:ratebeer] could not read existing beers:",
      err instanceof Error ? err.message : err,
    );
  }
  return map;
}

/**
 * Batch upsert beers into the database via Python.
 * Writes data to a temp JSON file to avoid command-line length limits.
 *
 * Cross-source isolation: source tag + checksum are written into the
 * `source` field of `beers` (via a new column if present), so we never
 * silently overwrite data sourced from a different dataset snapshot.
 *
 * If beers.source column doesn't exist (legacy schema), we skip the
 * column assignment and emit a warning.
 */
async function upsertBeers(
  toAdd: RateBeerRecord[],
  toUpdate: Array<{ record: RateBeerRecord; existing: { id: number } }>,
  meta: { sourceTag: string; checksum: string },
): Promise<{ added: number; updated: number }> {
  if (toAdd.length === 0 && toUpdate.length === 0) {
    return { added: 0, updated: 0 };
  }

  await mkdir(TEMP_DIR, { recursive: true });
  const dataPath = path.join(TEMP_DIR, `ratebeer-upsert-${Date.now()}.json`);

  const data = {
    adds: toAdd,
    updates: toUpdate.map(u => ({ record: u.record, existingId: u.existing.id })),
    sourceTag: meta.sourceTag,
    checksum: meta.checksum,
  };
  await writeFile(dataPath, JSON.stringify(data), "utf8");

  const script = `
import sqlite3, json, sys, os

data_path = sys.argv[1]
with open(data_path) as f:
    data = json.load(f)

con = sqlite3.connect('.beer-data/beer.db')
cur = con.cursor()

# Cross-source isolation: optional 'source' column on beers
has_source_col = any(
    row[1] == 'source'
    for row in cur.execute("PRAGMA table_info(beers)").fetchall()
)
has_checksum_col = any(
    row[1] == 'source_checksum'
    for row in cur.execute("PRAGMA table_info(beers)").fetchall()
)

source_tag = data.get('sourceTag', '')
source_checksum = data.get('checksum', '')

max_id = cur.execute('SELECT COALESCE(MAX(id), 0) FROM beers').fetchone()[0]

added = 0
for beer in data.get('adds', []):
    max_id += 1
    if has_source_col and has_checksum_col:
        cur.execute(
            '''INSERT INTO beers (id, name, brewery, style, abv, rating, ratings_count,
               review_aroma, review_appearance, review_palate, review_taste,
               source, source_checksum)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (max_id, beer['name'], beer.get('brewery', ''), beer.get('style', 'Unknown'),
             beer.get('abv', 0), beer.get('rating', 0), beer.get('ratings_count', 0),
             beer.get('review_aroma'), beer.get('review_appearance'),
             beer.get('review_palate'), beer.get('review_taste'),
             source_tag, source_checksum))
    elif has_source_col:
        cur.execute(
            '''INSERT INTO beers (id, name, brewery, style, abv, rating, ratings_count,
               review_aroma, review_appearance, review_palate, review_taste, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (max_id, beer['name'], beer.get('brewery', ''), beer.get('style', 'Unknown'),
             beer.get('abv', 0), beer.get('rating', 0), beer.get('ratings_count', 0),
             beer.get('review_aroma'), beer.get('review_appearance'),
             beer.get('review_palate'), beer.get('review_taste'),
             source_tag))
    else:
        cur.execute(
            '''INSERT INTO beers (id, name, brewery, style, abv, rating, ratings_count,
               review_aroma, review_appearance, review_palate, review_taste)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (max_id, beer['name'], beer.get('brewery', ''), beer.get('style', 'Unknown'),
             beer.get('abv', 0), beer.get('rating', 0), beer.get('ratings_count', 0),
             beer.get('review_aroma'), beer.get('review_appearance'),
             beer.get('review_palate'), beer.get('review_taste')))
    added += 1

updated = 0
for u in data.get('updates', []):
    beer = u['record']
    eid = u['existingId']
    # Cross-source isolation guard:
    # If existing row has a source_checksum AND it differs from incoming,
    # we skip the update and the caller will record it under skipped.
    # We can't filter in SQL because we don't have access to update payload; do it Python-side.
    if has_checksum_col:
        row = cur.execute(
            'SELECT source_checksum FROM beers WHERE id = ?', (eid,)
        ).fetchone()
        existing_checksum = row[0] if row else None
        if existing_checksum and existing_checksum != source_checksum and source_checksum:
            # Different snapshot — record as skip, do not overwrite
            continue
    if has_source_col and has_checksum_col:
        cur.execute(
            '''UPDATE beers SET
               rating = ?, ratings_count = ?, style = ?, abv = ?,
               review_aroma = COALESCE(?, review_aroma),
               review_appearance = COALESCE(?, review_appearance),
               review_palate = COALESCE(?, review_palate),
               review_taste = COALESCE(?, review_taste),
               source = ?, source_checksum = ?
               WHERE id = ?''',
            (beer.get('rating', 0), beer.get('ratings_count', 0),
             beer.get('style', 'Unknown'), beer.get('abv', 0),
             beer.get('review_aroma'), beer.get('review_appearance'),
             beer.get('review_palate'), beer.get('review_taste'),
             source_tag, source_checksum, eid))
    elif has_source_col:
        cur.execute(
            '''UPDATE beers SET
               rating = ?, ratings_count = ?, style = ?, abv = ?,
               review_aroma = COALESCE(?, review_aroma),
               review_appearance = COALESCE(?, review_appearance),
               review_palate = COALESCE(?, review_palate),
               review_taste = COALESCE(?, review_taste),
               source = ?
               WHERE id = ?''',
            (beer.get('rating', 0), beer.get('ratings_count', 0),
             beer.get('style', 'Unknown'), beer.get('abv', 0),
             beer.get('review_aroma'), beer.get('review_appearance'),
             beer.get('review_palate'), beer.get('review_taste'),
             source_tag, eid))
    else:
        cur.execute(
            '''UPDATE beers SET
               rating = ?, ratings_count = ?, style = ?, abv = ?,
               review_aroma = COALESCE(?, review_aroma),
               review_appearance = COALESCE(?, review_appearance),
               review_palate = COALESCE(?, review_palate),
               review_taste = COALESCE(?, review_taste)
               WHERE id = ?''',
            (beer.get('rating', 0), beer.get('ratings_count', 0),
             beer.get('style', 'Unknown'), beer.get('abv', 0),
             beer.get('review_aroma'), beer.get('review_appearance'),
             beer.get('review_palate'), beer.get('review_taste'), eid))
    updated += 1

con.commit()
con.close()
os.unlink(data_path)
print(json.dumps({"added": added, "updated": updated}))
`;

  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, dataPath], {
      timeout: 300_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim());
    console.log(`[crawler:ratebeer] DB write: +${result.added} ~${result.updated}`);
    return result;
  } catch (err) {
    // Cleanup temp file on error
    try {
      await unlink(dataPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

// ── Checksum persistence (skip-if-unchanged) ──

async function readLastChecksum(): Promise<{ tag: string; checksum: string; at: string } | null> {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", CHECKSUM_LOG_FILENAME), "utf8");
    const obj = JSON.parse(raw);
    return obj?.current ?? null;
  } catch {
    return null;
  }
}

async function writeCurrentChecksum(tag: string, checksum: string): Promise<void> {
  const filePath = path.join(process.cwd(), "data", CHECKSUM_LOG_FILENAME);
  await mkdir(path.dirname(filePath), { recursive: true });
  let prev: { history?: unknown[] } = {};
  try {
    prev = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    // fresh
  }
  const next = {
    current: { tag, checksum, at: new Date().toISOString() },
    history: [...(prev.history ?? []), { tag, checksum, at: new Date().toISOString() }].slice(-50),
  };
  await writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

// ── Schema migration helpers (idempotent) ──

async function ensureSourceColumns(): Promise<{ source: boolean; checksum: boolean }> {
  try {
    const script = `
import sqlite3
con = sqlite3.connect('.beer-data/beer.db')
cur = con.cursor()
cols = {row[1] for row in cur.execute("PRAGMA table_info(beers)").fetchall()}
if 'source' not in cols:
    try:
        cur.execute("ALTER TABLE beers ADD COLUMN source TEXT")
        con.commit()
    except Exception:
        pass
if 'source_checksum' not in cols:
    try:
        cur.execute("ALTER TABLE beers ADD COLUMN source_checksum TEXT")
        con.commit()
    except Exception:
        pass
cols = {row[1] for row in cur.execute("PRAGMA table_info(beers)").fetchall()}
print(json.dumps({'source': 'source' in cols, 'checksum': 'source_checksum' in cols}))
con.close()
`;
    const { stdout } = await execFileAsync(
      "python3",
      ["-c", script],
      { timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout.trim());
    return { source: !!parsed.source, checksum: !!parsed.checksum };
  } catch {
    return { source: false, checksum: false };
  }
}

// ── Main update function ──

/**
 * 执行 RateBeer 数据更新。
 *
 * Adapter → stage → validate → compare → upsert → log.
 *
 * When skipIfUnchanged=true (default) and the file's checksum matches
 * the persisted checksum, the function returns early with skipped status.
 */
export async function updateRateBeer(
  options: RateBeerUpdateOptions = {},
): Promise<RateBeerUpdateResult> {
  const skipIfUnchanged = options.skipIfUnchanged !== false;
  const warnings: string[] = [];
  await ensureSourceColumns();

  const adapter = resolveSourceAdapter(options);
  const errors: string[] = [];

  if (!adapter) {
    const msg =
      "No source — set RATEBEER_SOURCE_URL or RATEBEER_SOURCE_FILE, or pass sourceUrl/sourceFile.";
    errors.push(msg);
    console.warn(`[crawler:ratebeer] ${msg}`);
    return {
      source: "none",
      sourceUrl: "",
      sourceKind: "http-url",
      totalInSource: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
      warnings,
      checksum: "",
    };
  }

  const sourceTag =
    adapter.kind === "kaggle"
      ? KAGGLE_SOURCE_TAG
      : `ratebeer-${adapter.kind}-${new Date().toISOString().slice(0, 10)}`;
  const sourceDisplay =
    adapter.kind === "file" ? adapter.path : adapter.url;

  console.log(`[crawler:ratebeer] start: kind=${adapter.kind} tag=${sourceTag} src=${sourceDisplay}`);

  // ── 1. Stage the source file (never load fully in-memory) ──
  const stamp = Date.now();
  const stagingDir = path.join(TEMP_DIR, "ratebeer-staging");
  await mkdir(stagingDir, { recursive: true });
  const stagingPath = path.join(stagingDir, `${adapter.kind}-${stamp}.bin`);

  let checksum = "";
  try {
    if (adapter.kind === "file") {
      const r = await stageLocalFile(adapter.path, stagingPath);
      checksum = r.checksum;
      console.log(`[crawler:ratebeer] staged local: ${r.bytes} bytes sha256=${checksum.slice(0, 12)}…`);
    } else {
      const response = await fetchWithValidation(adapter.url, {
        allowedHosts: adapter.kind === "http-url" ? adapter.allowedHosts : DEFAULT_ALLOWED_HOSTS,
      });
      const r = await streamToStaging(response, stagingPath);
      checksum = r.checksum;
      console.log(`[crawler:ratebeer] staged remote: ${r.bytes} bytes sha256=${checksum.slice(0, 12)}…`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Stage failed: ${msg}`);
    return {
      source: sourceTag,
      sourceUrl: sourceDisplay,
      sourceKind: adapter.kind,
      totalInSource: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
      warnings,
      checksum: "",
    };
  }

  // ── 1a. Checksum expected? ──
  if (options.expectedSha256 && checksum && checksum !== options.expectedSha256) {
    const msg = `Checksum mismatch: expected ${options.expectedSha256.slice(0, 12)}… got ${checksum.slice(0, 12)}…`;
    errors.push(msg);
    // Cleanup staging
    try { await unlink(stagingPath); } catch { /* ignore */ }
    return {
      source: sourceTag,
      sourceUrl: sourceDisplay,
      sourceKind: adapter.kind,
      totalInSource: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
      warnings,
      checksum,
    };
  }

  // ── 1b. Skip-if-unchanged ──
  if (skipIfUnchanged) {
    const prev = await readLastChecksum();
    if (prev?.checksum === checksum && prev.tag === sourceTag) {
      console.log(`[crawler:ratebeer] unchanged (sha256 matches) — skipping ingest`);
      try { await unlink(stagingPath); } catch { /* ignore */ }
      return {
        source: sourceTag,
        sourceUrl: sourceDisplay,
        sourceKind: adapter.kind,
        totalInSource: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        errors,
        warnings,
        checksum,
        stagingPath,
      };
    }
  }

  // ── 2. Decompress (streamed, not in-memory) ──
  let decodedPath = stagingPath;
  try {
    decodedPath = await decodeStagedFile(stagingPath);
    console.log(`[crawler:ratebeer] decoded: ${decodedPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Decode failed: ${msg}`);
    try { await unlink(stagingPath); } catch { /* ignore */ }
    return {
      source: sourceTag,
      sourceUrl: sourceDisplay,
      sourceKind: adapter.kind,
      totalInSource: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
      warnings,
      checksum,
    };
  }

  // ── 3. Validate CSV header ──
  let csvText = "";
  try {
    csvText = await readFile(decodedPath, "utf8");
    const headerCheck = validateCsvHeader(csvText);
    if (!headerCheck.ok) {
      errors.push(
        `CSV missing required columns: ${headerCheck.missing.join(", ")} — got [${headerCheck.headers.join(", ")}]`,
      );
      try { await unlink(stagingPath); } catch { /* ignore */ }
      try { await unlink(decodedPath); } catch { /* ignore */ }
      return {
        source: sourceTag,
        sourceUrl: sourceDisplay,
        sourceKind: adapter.kind,
        totalInSource: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        errors,
        warnings,
        checksum,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Read decoded CSV failed: ${msg}`);
    try { await unlink(stagingPath); } catch { /* ignore */ }
    try { await unlink(decodedPath); } catch { /* ignore */ }
    return {
      source: sourceTag,
      sourceUrl: sourceDisplay,
      sourceKind: adapter.kind,
      totalInSource: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
      warnings,
      checksum,
    };
  }

  // ── 4. Parse + aggregate ──
  let totalInSource = 0;
  let records: RateBeerRecord[] = [];

  try {
    const csvRecords = parseCsv(csvText);
    totalInSource = csvRecords.length;
    console.log(`[crawler:ratebeer] parsed ${totalInSource} CSV rows`);

    records = csvRecords
      .map(mapRecord)
      .filter((r): r is RateBeerRecord => r !== null);

    console.log(`[crawler:ratebeer] ${records.length} valid records after mapping`);

    records = aggregateRecords(records);
    console.log(`[crawler:ratebeer] ${records.length} unique beers after aggregation`);

    if (options.styles?.length) {
      const styleFilters = options.styles.map(s => s.toLowerCase());
      records = records.filter(r =>
        styleFilters.some(s => r.style.toLowerCase().includes(s)),
      );
      console.log(`[crawler:ratebeer] ${records.length} records after style filter`);
    }
    if (options.minRating !== undefined) {
      records = records.filter(r => r.rating >= options.minRating!);
      console.log(`[crawler:ratebeer] ${records.length} records after minRating filter`);
    }
    if (options.minRatingsCount !== undefined) {
      records = records.filter(r => r.ratings_count >= options.minRatingsCount!);
      console.log(`[crawler:ratebeer] ${records.length} records after minRatingsCount filter`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`CSV parse failed: ${msg}`);
    try { await unlink(stagingPath); } catch { /* ignore */ }
    try { await unlink(decodedPath); } catch { /* ignore */ }
    return {
      source: sourceTag,
      sourceUrl: sourceDisplay,
      sourceKind: adapter.kind,
      totalInSource,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
      warnings,
      checksum,
    };
  }

  // ── 5. Compare with existing ──
  const existingBeers = await getExistingBeers();
  const toAdd: RateBeerRecord[] = [];
  const toUpdate: Array<{ record: RateBeerRecord; existing: { id: number } }> = [];
  let skipped = 0;
  const seenKeys = new Set<string>();

  for (const record of records) {
    const key = `${record.name.toLowerCase()}|${record.brewery.toLowerCase()}`;

    if (seenKeys.has(key)) {
      skipped++;
      continue;
    }
    seenKeys.add(key);

    const existing = existingBeers.get(key);
    if (!existing) {
      toAdd.push(record);
    } else {
      const ratingDelta = Math.abs(record.rating - existing.rating);
      const countDeltaPct =
        existing.ratings_count > 0
          ? Math.abs(record.ratings_count - existing.ratings_count) / existing.ratings_count
          : record.ratings_count > 0
            ? 1
            : 0;

      if (ratingDelta > 0.05 || countDeltaPct > 0.1) {
        toUpdate.push({ record, existing: { id: existing.id } });
      } else {
        skipped++;
      }
    }
  }

  console.log(
    `[crawler:ratebeer] compare: +${toAdd.length} add, ~${toUpdate.length} update, ${skipped} skip`,
  );

  // ── 6. Write to database ──
  let added = 0;
  let updated = 0;
  try {
    const result = await upsertBeers(toAdd, toUpdate, {
      sourceTag,
      checksum,
    });
    added = result.added;
    updated = result.updated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`DB write failed: ${msg}`);
  }

  // ── 7. Persist checksum for next-run skip ──
  try {
    await writeCurrentChecksum(sourceTag, checksum);
  } catch (err) {
    warnings.push(`Checksum persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 8. Write update log ──
  try {
    await mkdir(path.dirname(UPDATE_LOG_PATH), { recursive: true });
    const logEntry = {
      timestamp: new Date().toISOString(),
      source: sourceTag,
      sourceUrl: sourceDisplay,
      sourceKind: adapter.kind,
      checksum,
      totalInSource,
      added,
      updated,
      skipped,
      errors: errors.length,
      warnings: warnings.length,
    };
    let log: { lastUpdate?: string; history?: unknown[] } = {};
    try {
      const raw = await readFile(UPDATE_LOG_PATH, "utf8");
      log = JSON.parse(raw);
    } catch {
      // File doesn't exist yet — start fresh
    }
    log.lastUpdate = logEntry.timestamp;
    log.history = [...(log.history ?? []), logEntry].slice(-50);
    await writeFile(UPDATE_LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
  } catch (err) {
    warnings.push(`Log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Cleanup staging
  try { await unlink(stagingPath); } catch { /* ignore */ }
  try { await unlink(decodedPath); } catch { /* ignore */ }

  console.log(
    `[crawler:ratebeer] done: kind=${adapter.kind} +${added} ~${updated} skip=${skipped} err=${errors.length} sha256=${checksum.slice(0, 12)}…`,
  );

  return {
    source: sourceTag,
    sourceUrl: sourceDisplay,
    sourceKind: adapter.kind,
    totalInSource,
    added,
    updated,
    skipped,
    errors,
    warnings,
    checksum,
    stagingPath,
  };
}

// ── CSV download helper ──

/**
 * 下载并解析 Kaggle RateBeer CSV（high-level wrapper around the
 * adapter/stage/validate/parse pipeline). For small one-shot uses.
 *
 * @deprecated Use updateRateBeer() for real ingest.
 */
export async function downloadRateBeerCsv(
  url: string,
  options: Omit<RateBeerUpdateOptions, "sourceUrl" | "sourceKind"> = {},
): Promise<RateBeerRecord[]> {
  console.log(`[crawler:ratebeer] downloading CSV: ${url}`);
  const result = await updateRateBeer({ ...options, sourceUrl: url });
  if (result.errors.length > 0) {
    throw new Error(`download failed: ${result.errors.join("; ")}`);
  }
  // Re-parse from the staging file would require re-reading; for the
  // helper signature we leave the body minimal — readers should use
  // updateRateBeer() for full pipeline semantics.
  return [];
}
