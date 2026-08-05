#!/usr/bin/env node
/**
 * scripts/run-sanity-50.mjs
 *
 * Untappd real-fetch sanity check — 50 records, dev cookie, concurrency 2.
 * Surfaces blockers in brewery / country / 5-tab detail pages.
 *
 * Output:
 *   - Real-time progress on stdout (CLI progress bar)
 *   - data/crawler/_logs/sanity-50.jsonl (one record per line)
 *   - data/crawler/_logs/sanity-50-report.json (final summary)
 *
 * Usage:
 *   export UNTAPPD_DEV_COOKIE="untappd_sid=xxxxx; untappd_user=xxxxx"
 *   node scripts/run-sanity-50.mjs                # 50 records, concurrency 2
 *   node scripts/run-sanity-50.mjs --limit 10     # 10 records
 *   node scripts/run-sanity-50.mjs --dry-run      # mock fetch, no real calls
 *   node scripts/run-sanity-50.mjs --concurrency 1
 *
 * Safety:
 *   - Cookie MUST come from env UNTAPPD_DEV_COOKIE (never file)
 *   - Stop after 5 consecutive cookie failures
 *   - Hard cap concurrency at 2 (override via --concurrency 1)
 *   - 1 req/s per cookie hard floor
 *   - 429 → respect Retry-After (60s max wait)
 *   - All data goes to _logs/ (NEVER to DB)
 */

import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limit = parseIntArg(args, "--limit", 50);
const dryRun = args.includes("--dry-run");
const concurrency = Math.min(2, Math.max(1, parseIntArg(args, "--concurrency", 2)));

// ── Constants ─────────────────────────────────────────────────────────────

const COOKIE_ENV = process.env.UNTAPPD_DEV_COOKIE;
const LOG_DIR = "data/crawler/_logs";
const JSONL_PATH = join(LOG_DIR, "sanity-50.jsonl");
const REPORT_PATH = join(LOG_DIR, "sanity-50-report.json");
const TOP_URL = "https://untappd.com/beers/top";
const REQ_FLOOR_MS = 1000; // 1 req/s per cookie
const MAX_CONSECUTIVE_FAILS = 5;
const MAX_RETRY_AFTER_MS = 60_000;

function parseIntArg(arr, flag, def) {
  const i = arr.indexOf(flag);
  if (i < 0 || i + 1 >= arr.length) return def;
  const n = parseInt(arr[i + 1], 10);
  return Number.isFinite(n) ? n : def;
}

function nowIso() {
  return new Date().toISOString();
}

// ── Pre-flight ────────────────────────────────────────────────────────────

if (!dryRun && !COOKIE_ENV) {
  console.error("✗ UNTAPPD_DEV_COOKIE env not set");
  console.error("  export UNTAPPD_DEV_COOKIE=\"untappd_sid=xxxxx; untappd_user=xxxxx\"");
  console.error("  Or use --dry-run for mock mode");
  process.exit(2);
}

await mkdir(LOG_DIR, { recursive: true });
if (!existsSync(JSONL_PATH)) {
  await writeFile(JSONL_PATH, "", "utf8");
}

// ── Mock fetch (dry-run) ───────────────────────────────────────────────────

async function mockFetch(url) {
  await sleep(50);
  return {
    url,
    status: 200,
    html: `<html><body>mock for ${url}</body></html>`,
    retry_after_ms: null,
  };
}

// ── Real fetch (Untappd) ──────────────────────────────────────────────────

let lastReqAt = 0;
async function realFetch(url) {
  const since = Date.now() - lastReqAt;
  if (since < REQ_FLOOR_MS) await sleep(REQ_FLOOR_MS - since);
  lastReqAt = Date.now();

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Cookie: COOKIE_ENV,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  let retryAfterMs = null;
  const ra = resp.headers.get("retry-after");
  if (ra) {
    const n = parseInt(ra, 10);
    if (Number.isFinite(n)) retryAfterMs = Math.min(n * 1000, MAX_RETRY_AFTER_MS);
  }

  const html = resp.status >= 200 && resp.status < 300 ? await resp.text() : "";

  return {
    url,
    status: resp.status,
    html,
    retry_after_ms: retryAfterMs,
  };
}

const doFetch = dryRun ? mockFetch : realFetch;

// ── Block detection ───────────────────────────────────────────────────────

function detectBlocker(entry) {
  const block = [];
  if (entry.status === 429) block.push("rate_limit");
  if (entry.status === 403) block.push("forbidden");
  if (entry.status >= 500) block.push("server_error");
  if (entry.url.includes("/brewery/")) block.push("brewery_switch");
  if (entry.url.includes("/beer/") && entry.url.match(/\/\d+\//)) block.push("detail_tab");
  if (entry.html && entry.html.length < 500) block.push("thin_html");
  return block;
}

// ── Worker pool ───────────────────────────────────────────────────────────

async function runSanity() {
  const start = Date.now();
  const entries = [];
  const errors = [];
  const blockers = new Map();
  let consecutiveFails = 0;
  let done = 0;
  let lastBeerIds = []; // for brewery/country switch variety

  // 50 fetch slots — mix of top-list, detail, brewery, country
  const slots = [];
  for (let i = 0; i < limit; i++) {
    const kind =
      i % 5 === 0 ? "brewery"
      : i % 7 === 0 ? "country"
      : i % 3 === 0 ? "detail"
      : "top";
    let url;
    if (kind === "top") {
      url = TOP_URL;
    } else if (kind === "detail") {
      const id = 1 + (i * 13) % 50000;
      url = `https://untappd.com/beer/${id}`;
    } else if (kind === "brewery") {
      const id = 1 + (i * 7) % 50000;
      url = `https://untappd.com/brewery/${id}`;
    } else {
      url = "https://untappd.com/country/77"; // Japan
    }
    slots.push({ kind, url, idx: i });
  }

  // progress bar
  const renderBar = (done, total, status) => {
    const pct = Math.round((done / total) * 30);
    const bar = "█".repeat(pct) + "░".repeat(30 - pct);
    process.stdout.write(
      `\r\x1b[36msanity-50\x1b[0m [\x1b[1m${bar}\x1b[0m] ${done}/${total} ${status}     `,
    );
  };

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= slots.length) return;
      const slot = slots[i];
      const entry = {
        idx: i,
        kind: slot.kind,
        url: slot.url,
        ts: nowIso(),
        status: 0,
        html_len: 0,
        retry_after_ms: null,
        blockers: [],
        error: null,
      };
      try {
        const r = await doFetch(slot.url);
        entry.status = r.status;
        entry.html_len = r.html.length;
        entry.retry_after_ms = r.retry_after_ms;
        entry.blockers = detectBlocker(entry);
        consecutiveFails = r.status >= 400 ? consecutiveFails + 1 : 0;
        if (r.retry_after_ms) await sleep(r.retry_after_ms);
      } catch (e) {
        entry.error = String(e)?.slice(0, 200) ?? "unknown";
        consecutiveFails++;
      }
      if (entry.blockers.length) {
        for (const b of entry.blockers) {
          blockers.set(b, (blockers.get(b) ?? 0) + 1);
        }
      }
      if (entry.error) errors.push({ idx: i, url: entry.url, error: entry.error });
      entries.push(entry);
      await appendFile(JSONL_PATH, JSON.stringify(entry) + "\n", "utf8");
      done++;
      renderBar(done, slots.length,
        consecutiveFails > 0 ? `fail-streak=${consecutiveFails}` : "ok",
      );
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.error(`\n✗ aborting: ${MAX_CONSECUTIVE_FAILS} consecutive failures`);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  renderBar(slots.length, slots.length, "done");
  console.log();

  const ok = entries.filter((e) => e.status >= 200 && e.status < 300).length;
  const blocked = entries.filter((e) => e.status === 429 || e.status === 403).length;
  const errs = entries.filter((e) => e.error).length;
  const report = {
    started_at: new Date(start).toISOString(),
    ended_at: nowIso(),
    duration_ms: Date.now() - start,
    dry_run: dryRun,
    limit: slots.length,
    concurrency,
    cookie_source: dryRun ? "none" : "env",
    ok,
    blocked_4xx: blocked,
    errors: errs,
    success_rate: ok / slots.length,
    blockers: Object.fromEntries(blockers),
    by_kind: Object.fromEntries(
      ["top", "detail", "brewery", "country"].map((k) => [
        k,
        {
          total: entries.filter((e) => e.kind === k).length,
          ok: entries.filter((e) => e.kind === k && e.status >= 200 && e.status < 300).length,
        },
      ]),
    ),
    sample_errors: errors.slice(0, 5),
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n┌── sanity-50 report ──`);
  console.log(`│ ok:           ${ok}/${slots.length}`);
  console.log(`│ blocked:      ${blocked}`);
  console.log(`│ errors:       ${errs}`);
  console.log(`│ success_rate: ${(report.success_rate * 100).toFixed(1)}%`);
  console.log(`│ duration:     ${(report.duration_ms / 1000).toFixed(1)}s`);
  console.log(`│ by_kind:      top=${report.by_kind.top.ok}/${report.by_kind.top.total}  detail=${report.by_kind.detail.ok}/${report.by_kind.detail.total}  brewery=${report.by_kind.brewery.ok}/${report.by_kind.brewery.total}  country=${report.by_kind.country.ok}/${report.by_kind.country.total}`);
  if (Object.keys(report.blockers).length) {
    console.log(`│ blockers:`);
    for (const [k, v] of Object.entries(report.blockers)) {
      console.log(`│   ${k}: ${v}`);
    }
  }
  console.log(`└── jsonl: ${JSONL_PATH}`);
  console.log(`└── report: ${REPORT_PATH}`);
}

await runSanity();
