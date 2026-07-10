/**
 * Beer DB Updater — scheduled data refresh pipeline.
 *
 * Responsibilities:
 *   1. Trigger Untappd/RateBeer crawls
 *   2. Incrementally upsert results into SQLite
 *   3. Clean stale cache entries
 *   4. Expose refresh API for manual triggers
 *
 * Crawler implementations are in ./crawlers/untappd.ts and ./crawlers/ratebeer.ts.
 * This module handles scheduling, dedup, and the SQLite write path.
 */

import { execFile } from "node:child_process";
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
 * This is a placeholder — actual crawler implementations go in ./crawlers/.
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
  };

  try {
    if (params.source === "untappd" || params.source === "all") {
      // Placeholder: call Untappd crawler
      // const untappdResult = await crawlUntappd({ styles: params.styles, limit: params.limit });
      // result.added += untappdResult.added;
      // result.errors += untappdResult.errors;
      console.log("[updater] Untappd refresh: not yet implemented — see docs/beer-db-update-spec.md");
    }

    if (params.source === "ratebeer" || params.source === "all") {
      // Placeholder: call RateBeer updater
      console.log("[updater] RateBeer refresh: not yet implemented — see docs/beer-db-update-spec.md");
    }
  } catch (err) {
    result.ok = false;
    result.errors++;
    result.errorMessages.push(err instanceof Error ? err.message : String(err));
  }

  result.completedAt = new Date().toISOString();

  // Update last-update timestamp
  await touchLastUpdate();

  return result;
}

// ── Database stats ──

/**
 * Get comprehensive database statistics.
 */
export async function getDatabaseStats(): Promise<DbStats> {
  let dbStats: any = { total_beers: 0, total_breweries: 0, total_styles: 0, avg_rating: 0, top_styles: [] };

  try {
    const { stdout } = await execFileAsync(PYTHON, [LOOKUP_SCRIPT, "--stats"], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    dbStats = JSON.parse(stdout.trim());
  } catch (err) {
    console.warn("[updater] stats lookup failed:", err);
  }

  // Count untappd_cache separately
  let untappdCached = 0;
  try {
    const { stdout } = await execFileAsync(PYTHON, [
      "-c",
      `import sqlite3; con=sqlite3.connect('.beer-data/beer.db'); print(con.execute('SELECT COUNT(*) FROM untappd_cache').fetchone()[0])`,
    ], { timeout: 5000 });
    untappdCached = parseInt(stdout.trim(), 10) || 0;
  } catch {}

  const lastUpdate = await readLastUpdate();

  return {
    totalBeers: dbStats.total_beers ?? 0,
    untappdCached,
    ratebeerBeers: (dbStats.total_beers ?? 0) - untappdCached,
    lastUpdate,
    topStyles: (dbStats.top_styles ?? []).slice(0, 10).map((s: any) => ({
      style: s.style || "Unknown",
      count: s.count || 0,
    })),
  };
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
  await writeFile(UPDATE_LOG_PATH, JSON.stringify({
    lastUpdate: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

// ── Cron-like scheduler (placeholder) ──

let _schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic database refresh.
 * Weekly Untappd refresh, monthly RateBeer refresh.
 */
export function startScheduler(): void {
  if (_schedulerInterval) return;

  // Run on startup
  console.log("[updater] scheduler started (weekly: Untappd, monthly: RateBeer)");

  _schedulerInterval = setInterval(async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const dayOfMonth = now.getDate();

    // Weekly: every Monday at 3am for Untappd
    if (dayOfWeek === 1 && now.getHours() === 3 && now.getMinutes() < 5) {
      console.log("[updater] running weekly Untappd refresh...");
      await refreshDatabase({ source: "untappd" });
    }

    // Monthly: 1st of month at 4am for RateBeer
    if (dayOfMonth === 1 && now.getHours() === 4 && now.getMinutes() < 5) {
      console.log("[updater] running monthly RateBeer refresh...");
      await refreshDatabase({ source: "ratebeer" });
    }
  }, 300_000); // Check every 5 minutes
}

export function stopScheduler(): void {
  if (_schedulerInterval) {
    clearInterval(_schedulerInterval);
    _schedulerInterval = null;
  }
}
