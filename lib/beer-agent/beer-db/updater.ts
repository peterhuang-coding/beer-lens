/**
 * Beer DB Updater — scheduled data refresh pipeline.
 *
 * Responsibilities:
 *   1. Trigger Untappd/RateBeer crawls
 *   2. Hand Untappd payload to lookup.py `--upsert-untappd` (transactional)
 *   3. Hand RateBeer result to upsertBeers (Python child-process)
 *   4. Track last-update timestamp + run history
 *   5. Expose refresh API for manual triggers
 *
 * Crawler implementations are in ./crawlers/{untappd,ratebeer,flickr}.ts.
 * This module is now THE scheduler + dispatcher only — write-side concerns
 * belong in the Python helpers.
 */

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const PYTHON = "python3";
const LOOKUP_SCRIPT = path.join(process.cwd(), ".beer-data", "lookup.py");

// ── Types ──

export type RefreshSource = "untappd" | "ratebeer" | "all";

export type RefreshParams = {
  source: RefreshSource;
  styles?: string[];
  limit?: number;
  /** When true, forces re-evaluation of every crawled record (lookup.py writes
   *  to DB regardless of whether it already exists). */
  forceUpsert?: boolean;
  /** Image-only crawl — Wikimedia Commons primary, Flickr API fallback. */
  includeImages?: boolean;
};

export type RefreshResult = {
  ok: boolean;
  source: RefreshSource;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
  startedAt: string;
  completedAt: string;
  /** Source-tagged result details from each upstream crawler. */
  details?: {
    untappd?: {
      beersFound: number;
      upsertResult?: Record<string, unknown>;
    };
    ratebeer?: {
      source: string;
      total: number;
      added: number;
      updated: number;
      skipped: number;
      checksum: string;
    };
    images?: {
      mode: string;
      imageCount: number;
      rawPath: string;
    };
  };
};

export type DbStats = {
  totalBeers: number;
  untappdCached: number;
  ratebeerBeers: number;
  lastUpdate: string | null;
  topStyles: Array<{ style: string; count: number }>;
};

// ── Refresh ──

/**
 * Trigger a beer database refresh.
 *
 * Routes:
 *   - "untappd" → crawlUntappd (with option.forceUpsert) → lookup.py --upsert-untappd
 *   - "ratebeer" → updateRateBeer (writes its own DB path)
 *   - "all" → both
 */
export async function refreshDatabase(params: RefreshParams): Promise<RefreshResult> {
  const startedAt = new Date().toISOString();
  const result: RefreshResult = {
    ok: true,
    source: params.source,
    added: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
    startedAt,
    completedAt: "",
    details: {},
  };

  if (params.source === "untappd" || params.source === "all") {
    try {
      const { crawlUntappd } = await import("./crawlers/untappd");
      const untappdResult = await crawlUntappd({
        styles: params.styles,
        limit: params.limit,
        forceUpsert: params.forceUpsert === true,
      });
      result.details!.untappd = {
        beersFound: untappdResult.beers.length,
        upsertResult: undefined,
      };

      // Hand the payload to Python for transactional upsert
      if (untappdResult.beers.length > 0) {
        const upsert = await callLookupUpsert(untappdResult.beers);
        result.details!.untappd.upsertResult = upsert;
        result.added += (upsert.inserted as number) ?? 0;
        result.updated += (upsert.updated as number) ?? 0;
        result.skipped += (upsert.skipped as number) ?? 0;
        if (Array.isArray(upsert.errors) && upsert.errors.length > 0) {
          result.errors += upsert.errors.length;
          for (const e of upsert.errors) {
            result.errorMessages.push(
              `untappd: ${typeof e === 'string' ? e : JSON.stringify(e)}`,
            );
          }
        }
      }
    } catch (err) {
      result.ok = false;
      result.errors++;
      result.errorMessages.push(
        `untappd: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (params.source === "ratebeer" || params.source === "all") {
    try {
      const { updateRateBeer } = await import("./crawlers/ratebeer");
      const ratebeerResult = await updateRateBeer({
        styles: params.styles,
        // Don't force re-applies on schedule runs
        skipIfUnchanged: true,
      });
      result.details!.ratebeer = {
        source: ratebeerResult.source,
        total: ratebeerResult.totalInSource,
        added: ratebeerResult.added,
        updated: ratebeerResult.updated,
        skipped: ratebeerResult.skipped,
        checksum: ratebeerResult.checksum,
      };
      result.added += ratebeerResult.added;
      result.updated += ratebeerResult.updated;
      result.skipped += ratebeerResult.skipped;
      if (ratebeerResult.errors.length > 0) {
        result.errors += ratebeerResult.errors.length;
        for (const e of ratebeerResult.errors) {
          result.errorMessages.push(`ratebeer: ${e}`);
        }
      }
    } catch (err) {
      result.ok = false;
      result.errors++;
      result.errorMessages.push(
        `ratebeer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (params.includeImages) {
    try {
      const { searchBeerLabels } = await import("./crawlers/flickr");
      const imageResult = await searchBeerLabels({
        mode: "auto",
        query: "beer label",
        limit: 50,
      });
      result.details!.images = {
        mode: imageResult.mode,
        imageCount: imageResult.images.length,
        rawPath: imageResult.rawPath,
      };
      if (imageResult.errors.length > 0) {
        for (const e of imageResult.errors) result.errorMessages.push(`images: ${e}`);
      }
    } catch (err) {
      result.ok = false;
      result.errors++;
      result.errorMessages.push(
        `images: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  result.completedAt = new Date().toISOString();
  await touchLastUpdate();
  return result;
}

// ── Database stats ──

/**
 * Get comprehensive database statistics.
 */
export async function getDatabaseStats(): Promise<DbStats> {
  const dbStatsRaw: any = {
    total_beers: 0,
    total_breweries: 0,
    total_styles: 0,
    avg_rating: 0,
    top_styles: [],
  };

  try {
    const { stdout } = await execFileAsync(PYTHON, [LOOKUP_SCRIPT, "--stats"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    Object.assign(dbStatsRaw, JSON.parse(stdout.trim()));
  } catch (err) {
    console.warn("[updater] stats lookup failed:", err);
  }

  // Count untappd_cache separately
  let untappdCached = dbStatsRaw?.untappd_cache?.total ?? 0;
  if (!untappdCached) {
    try {
      const { stdout } = await execFileAsync(PYTHON, [
        "-c",
        `import sqlite3; con=sqlite3.connect('.beer-data/beer.db'); print(con.execute('SELECT COUNT(*) FROM untappd_cache').fetchone()[0])`,
      ], { timeout: 5_000 });
      untappdCached = parseInt(stdout.trim(), 10) || 0;
    } catch {
      // ignore
    }
  }

  const lastUpdate = await readLastUpdate();

  return {
    totalBeers: dbStatsRaw.total_beers ?? 0,
    untappdCached,
    ratebeerBeers: (dbStatsRaw.total_beers ?? 0) - untappdCached,
    lastUpdate,
    topStyles: (dbStatsRaw.top_styles ?? []).slice(0, 10).map((s: any) => ({
      style: s.style || "Unknown",
      count: s.count || 0,
    })),
  };
}

// ── Lookup.py bridge ──

/**
 * Hand a parsed Untappd payload to `lookup.py --upsert-untappd` for the
 * transactional write. Returns the parsed JSON envelope.
 *
 * Uses spawn (not execFile) because we need to pipe the JSON payload
 * through stdin and the promisified execFile wrapper does not expose the
 * `input` option.
 */
async function callLookupUpsert(beers: unknown[]): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [LOOKUP_SCRIPT, "--upsert-untappd", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      console.warn("[updater] upsert-untappd spawn error:", err.message);
      resolve({
        inserted: 0,
        updated: 0,
        skipped: 0,
        errors: [err.message],
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(
          `[updater] upsert-untappd exit=${code}: ${stderr.slice(0, 200)}`,
        );
        resolve({
          inserted: 0,
          updated: 0,
          skipped: 0,
          errors: [stderr || `exit code ${code}`],
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch {
        resolve({
          inserted: 0,
          updated: 0,
          skipped: 0,
          errors: ["non-JSON output from lookup.py"],
        });
      }
    });
    child.stdin.write(JSON.stringify(beers));
    child.stdin.end();
  });
}

// ── Last-update tracking ──

const UPDATE_LOG_PATH = path.join(process.cwd(), "data", "beer-db-update.json");

async function readLastUpdate(): Promise<string | null> {
  try {
    const raw = await readFile(UPDATE_LOG_PATH, "utf8");
    return JSON.parse(raw).lastUpdate ?? null;
  } catch {
    return null;
  }
}

async function touchLastUpdate(): Promise<void> {
  await mkdir(path.dirname(UPDATE_LOG_PATH), { recursive: true });
  let prev: any = {};
  try {
    prev = JSON.parse(await readFile(UPDATE_LOG_PATH, "utf8"));
  } catch {
    // fresh
  }
  prev.lastUpdate = new Date().toISOString();
  prev.lastRefreshSource = prev.lastRefreshSource ?? "scheduler";
  await writeFile(UPDATE_LOG_PATH, JSON.stringify(prev, null, 2) + "\n", "utf8");
}

// ── Cron-like scheduler ──

let _schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic database refresh.
 * Weekly Untappd refresh, monthly RateBeer refresh.
 */
export function startScheduler(): void {
  if (_schedulerInterval) return;

  console.log("[updater] scheduler started (weekly: Untappd, monthly: RateBeer)");

  _schedulerInterval = setInterval(async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const dayOfMonth = now.getDate();

    if (dayOfWeek === 1 && now.getHours() === 3 && now.getMinutes() < 5) {
      console.log("[updater] running weekly Untappd refresh...");
      await refreshDatabase({ source: "untappd" });
    }

    if (dayOfMonth === 1 && now.getHours() === 4 && now.getMinutes() < 5) {
      console.log("[updater] running monthly RateBeer refresh...");
      await refreshDatabase({ source: "ratebeer" });
    }
  }, 300_000);
}

export function stopScheduler(): void {
  if (_schedulerInterval) {
    clearInterval(_schedulerInterval);
    _schedulerInterval = null;
  }
}
