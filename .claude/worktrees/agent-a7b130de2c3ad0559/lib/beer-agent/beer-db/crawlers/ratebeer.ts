/**
 * RateBeer Data Updater — 从公开数据集更新 RateBeer 评分数据。
 *
 * 此文件是需求规格 + 桩代码。实际的更新逻辑交给其他 AI / 开发者完成。
 *
 * ## 数据来源
 *
 *   1. Kaggle RateBeer 数据集 (当前: 1.58M 评论聚合)
 *      https://www.kaggle.com/datasets/nicolashug/dataset-ratebeer
 *   2. BeerAdvocate 数据集
 *      https://www.kaggle.com/datasets/thedevastator/beer-ratings-from-beer-advocate
 *   3. OpenBeerDB
 *      https://openbeerdb.com/
 *
 * ## 更新流程
 *
 *   1. 下载最新数据集 CSV/ZIP
 *   2. 解析并提取：name, brewery, style, abv, avg_rating, review_count
 *   3. 与当前 beer.db 中的 beers 表对比
 *   4. 只更新有变化的条目（rating 变化 > 0.05 或 ratings_count 变化 > 10%）
 *   5. 新增条目追加
 *   6. 记录更新日志
 *
 * ## 去重
 *
 * - 按 name + brewery 组合去重
 * - 保留最新 rating
 * - 合并 ratings_count
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, unlink } from "node:fs/promises";
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
  totalInSource: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export type RateBeerUpdateOptions = {
  /** 数据源 URL（CSV/ZIP） */
  sourceUrl?: string;
  /** 只处理特定风格 */
  styles?: string[];
  /** 最小评分阈值（低于此值的跳过） */
  minRating?: number;
  /** 最小评价数阈值 */
  minRatingsCount?: number;
};

// ── Constants ──

const UPDATE_LOG_PATH = path.join(process.cwd(), "data", "beer-db-update.json");
const TEMP_DIR = path.join(process.cwd(), ".temp");

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

// ── Download ──

/**
 * Download a file from URL and decompress if needed.
 * Supports: plain CSV, gzip (.gz), and ZIP archives.
 */
async function downloadAndDecompress(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
    redirect: "follow" as const,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Gzip (magic: 0x1f 0x8b)
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const { gunzipSync } = await import("node:zlib");
    return gunzipSync(Buffer.from(buffer)).toString("utf8");
  }

  // ZIP (magic: PK 0x03 0x04)
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    await mkdir(TEMP_DIR, { recursive: true });
    const zipPath = path.join(TEMP_DIR, `ratebeer-${Date.now()}.zip`);
    await writeFile(zipPath, Buffer.from(buffer));

    try {
      // Use Python zipfile to extract first CSV (Python is guaranteed available)
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
          zipPath,
        ],
        { timeout: 60_000, maxBuffer: 500 * 1024 * 1024 },
      );
      return stdout;
    } finally {
      try {
        await unlink(zipPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // Plain text
  return new TextDecoder().decode(buffer);
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
 */
async function upsertBeers(
  toAdd: RateBeerRecord[],
  toUpdate: Array<{ record: RateBeerRecord; existing: { id: number } }>,
): Promise<{ added: number; updated: number }> {
  if (toAdd.length === 0 && toUpdate.length === 0) {
    return { added: 0, updated: 0 };
  }

  await mkdir(TEMP_DIR, { recursive: true });
  const dataPath = path.join(TEMP_DIR, `ratebeer-upsert-${Date.now()}.json`);

  const data = {
    adds: toAdd,
    updates: toUpdate.map(u => ({ record: u.record, existingId: u.existing.id })),
  };
  await writeFile(dataPath, JSON.stringify(data), "utf8");

  const script = `
import sqlite3, json, sys, os

data_path = sys.argv[1]
with open(data_path) as f:
    data = json.load(f)

con = sqlite3.connect('.beer-data/beer.db')
cur = con.cursor()

max_id = cur.execute('SELECT COALESCE(MAX(id), 0) FROM beers').fetchone()[0]

added = 0
for beer in data.get('adds', []):
    max_id += 1
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

// ── Main update function ──

/**
 * 执行 RateBeer 数据更新。
 *
 * 下载 CSV/ZIP → 解析 → 与现有 beers 表对比 → 增量更新 → 记录日志。
 * 只更新 rating 变化 > 0.05 或 ratings_count 变化 > 10% 的条目。
 */
export async function updateRateBeer(
  options: RateBeerUpdateOptions = {},
): Promise<RateBeerUpdateResult> {
  const sourceUrl = options.sourceUrl ?? "";
  const source = sourceUrl || "Kaggle RateBeer";
  const errors: string[] = [];

  console.log(`[crawler:ratebeer] start: source=${source}`);

  // ── 1. Download ──
  if (!sourceUrl) {
    const msg =
      "No sourceUrl — Kaggle requires authentication. Provide a direct CSV/ZIP URL via sourceUrl.";
    errors.push(msg);
    console.warn(`[crawler:ratebeer] ${msg}`);
    return {
      source,
      sourceUrl,
      totalInSource: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      errors,
    };
  }

  let csvText: string;
  try {
    console.log(`[crawler:ratebeer] downloading: ${sourceUrl}`);
    csvText = await downloadAndDecompress(sourceUrl);
    console.log(`[crawler:ratebeer] downloaded ${Math.round(csvText.length / 1024)} KB`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Download failed: ${msg}`);
    return { source, sourceUrl, totalInSource: 0, added: 0, updated: 0, skipped: 0, errors };
  }

  // ── 2. Parse CSV ──
  let totalInSource = 0;
  let records: RateBeerRecord[];

  try {
    const csvRecords = parseCsv(csvText);
    totalInSource = csvRecords.length;
    console.log(`[crawler:ratebeer] parsed ${totalInSource} CSV rows`);

    records = csvRecords
      .map(mapRecord)
      .filter((r): r is RateBeerRecord => r !== null);

    console.log(`[crawler:ratebeer] ${records.length} valid records after mapping`);

    // Aggregate individual reviews into per-beer records
    records = aggregateRecords(records);
    console.log(`[crawler:ratebeer] ${records.length} unique beers after aggregation`);

    // Apply filters
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
    return { source, sourceUrl, totalInSource, added: 0, updated: 0, skipped: 0, errors };
  }

  // ── 3. Compare with existing ──
  const existingBeers = await getExistingBeers();
  const toAdd: RateBeerRecord[] = [];
  const toUpdate: Array<{ record: RateBeerRecord; existing: { id: number } }> = [];
  let skipped = 0;
  const seenKeys = new Set<string>();

  for (const record of records) {
    const key = `${record.name.toLowerCase()}|${record.brewery.toLowerCase()}`;

    // Dedup within this batch
    if (seenKeys.has(key)) {
      skipped++;
      continue;
    }
    seenKeys.add(key);

    const existing = existingBeers.get(key);
    if (!existing) {
      // New beer — add
      toAdd.push(record);
    } else {
      // Check if update is needed
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

  // ── 4. Write to database ──
  let added = 0;
  let updated = 0;
  try {
    const result = await upsertBeers(toAdd, toUpdate);
    added = result.added;
    updated = result.updated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`DB write failed: ${msg}`);
  }

  // ── 5. Write update log ──
  try {
    await mkdir(path.dirname(UPDATE_LOG_PATH), { recursive: true });
    const logEntry = {
      timestamp: new Date().toISOString(),
      source,
      sourceUrl,
      totalInSource,
      added,
      updated,
      skipped,
      errors: errors.length,
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
    errors.push(`Log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[crawler:ratebeer] done: +${added} ~${updated} skip=${skipped} err=${errors.length}`,
  );

  return {
    source,
    sourceUrl,
    totalInSource,
    added,
    updated,
    skipped,
    errors,
  };
}

// ── CSV download helper ──

/**
 * 下载并解析 Kaggle RateBeer CSV。
 */
export async function downloadRateBeerCsv(url: string): Promise<RateBeerRecord[]> {
  console.log(`[crawler:ratebeer] downloading CSV: ${url}`);
  const csvText = await downloadAndDecompress(url);
  const csvRecords = parseCsv(csvText);
  console.log(`[crawler:ratebeer] parsed ${csvRecords.length} rows`);
  const records = csvRecords
    .map(mapRecord)
    .filter((r): r is RateBeerRecord => r !== null);
  return aggregateRecords(records);
}
