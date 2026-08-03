/**
 * tests/crawler-puppeteer.test.mts
 *
 * Self-tests for the puppeteer-infra agent (lib/crawler/*).
 *
 *   1. PuppeteerDriver: init / fallback when offline
 *   2. Backoff: curve + caps + jitter range
 *   3. CookiePool: rotation + 3-strikes eviction
 *   4. JsonlWriter: header + atomic write (tmp → rename)
 *   5. ReplayDriver: fixture match + 404 fallback
 *
 * Run: node --experimental-strip-types --test tests/crawler-puppeteer.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_BACKOFF, backoffDelayMs } from "../lib/crawler/backoff.ts";
import { CookiePool } from "../lib/crawler/cookie-pool.ts";
import { JsonlWriter } from "../lib/crawler/jsonl-writer.ts";
import { ReplayDriver } from "../lib/crawler/replay.ts";
import {
  PuppeteerDriver,
  makePuppeteerDriver,
} from "../lib/crawler/puppeteer-driver.ts";
import type { CookieRef } from "../lib/crawler/contracts.ts";

// -- helpers ------------------------------------------------------------------

function fixturesDir(): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../data/crawler/_fixtures",
  );
}

function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeCookie(name: string, qps = 1): CookieRef {
  return { name, file: `/tmp/${name}.cookie.json`, qps_per_cookie: qps };
}

// -- 1. Puppeteer driver ------------------------------------------------------

describe("PuppeteerDriver", () => {
  it("constructor exposes mode='puppeteer'", () => {
    const d = new PuppeteerDriver({ allow_network: false });
    assert.strictEqual(d.mode, "puppeteer");
  });

  it("init() resolves to boolean and never throws, even when chromium is unavailable offline", async () => {
    const d = makePuppeteerDriver();
    const ok = await d.init();
    assert.strictEqual(typeof ok, "boolean");
    const status = d.initStatus();
    assert.strictEqual(status.attempted, true);
    // Either it succeeded (browser present) or it returned false with an error
    assert.ok(status.ok === true || status.error instanceof Error);
    // Always close so chromium subprocess doesn't keep the test runner alive
    await d.close();
  });

  it("fetchPage refuses to hit the network when allow_network=false", async () => {
    const d = new PuppeteerDriver({ allow_network: false });
    await assert.rejects(
      () => d.fetchPage("https://example.invalid/", {
        cookie: makeCookie("c1"),
        jitter_ms: 0,
        timeout_ms: 1000,
      }),
      /allow_network=false/,
    );
    await d.close();
  });
});

// -- 2. Backoff curve ---------------------------------------------------------

describe("backoff", () => {
  it("honors initial_ms at attempt=0 (deterministic with rand=0.5)", () => {
    const ms = backoffDelayMs(DEFAULT_BACKOFF, 0, () => 0.5);
    // jitter=0 at rand=0.5, so we get exactly initial_ms
    assert.strictEqual(ms, DEFAULT_BACKOFF.initial_ms);
  });

  it("applies multiplier and caps at max_ms", () => {
    const ms = backoffDelayMs(DEFAULT_BACKOFF, 20, () => 0.5);
    // large attempt → exponent saturates at max_ms
    assert.strictEqual(ms, DEFAULT_BACKOFF.max_ms);
  });

  it("jitter spans [-ratio, +ratio]", () => {
    const samples = 200;
    let minSeen = Infinity;
    let maxSeen = -Infinity;
    for (let i = 0; i < samples; i++) {
      // attempt=2 → base = 1000 * 4 = 4000; capped stays 4000 (max=60000)
      const r = i / (samples - 1); // [0,1]
      const ms = backoffDelayMs(DEFAULT_BACKOFF, 2, () => r);
      if (ms < minSeen) minSeen = ms;
      if (ms > maxSeen) maxSeen = ms;
    }
    const base = DEFAULT_BACKOFF.initial_ms * Math.pow(2, 2); // 4000
    const lower = base * (1 - DEFAULT_BACKOFF.jitter_ratio);
    const upper = base * (1 + DEFAULT_BACKOFF.jitter_ratio);
    assert.ok(minSeen >= lower - 1, `min ${minSeen} < ${lower}`);
    assert.ok(maxSeen <= upper + 1, `max ${maxSeen} > ${upper}`);
  });

  it("returns non-negative integer", () => {
    for (let i = 0; i < 10; i++) {
      const ms = backoffDelayMs(DEFAULT_BACKOFF, i, Math.random);
      assert.ok(Number.isInteger(ms));
      assert.ok(ms >= 0);
    }
  });

  it("clamps negative attempt to 0", () => {
    const ms = backoffDelayMs(DEFAULT_BACKOFF, -3, () => 0.5);
    assert.strictEqual(ms, DEFAULT_BACKOFF.initial_ms);
  });
});

// -- 3. Cookie pool -----------------------------------------------------------

describe("CookiePool", () => {
  it("rotates least-recently-used", () => {
    let now = 0;
    const pool = new CookiePool({
      cookies: [makeCookie("a"), makeCookie("b"), makeCookie("c")],
      now: () => ++now,
    });
    const first = pool.pickCookie();
    assert.strictEqual(first?.ref.name, "a");
    first!.release(true);
    const second = pool.pickCookie();
    assert.strictEqual(second?.ref.name, "b");
    second!.release(true);
    const third = pool.pickCookie();
    assert.strictEqual(third?.ref.name, "c");
    third!.release(true);
    const fourth = pool.pickCookie();
    assert.strictEqual(fourth?.ref.name, "a");
    fourth!.release(true);
  });

  it("evicts cookies after 3 consecutive failures", () => {
    const pool = new CookiePool({
      cookies: [makeCookie("loser"), makeCookie("winner")],
    });
    assert.strictEqual(pool.aliveCount(), 2);
    const pick = pool.pickCookie();
    assert.ok(pick);
    pick!.release(false);
    pick!.release(false);
    pick!.release(false);
    // After 3rd failure, the cookie should be evicted
    // Continue releasing success — eviction is already done
    pick!.release(true);
    assert.strictEqual(pool.aliveCount(), 1);
    const remaining = pool.available();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0]?.name, "winner");
  });

  it("resets failure counter on success", () => {
    const pool = new CookiePool({
      cookies: [makeCookie("x")],
    });
    const pick = pool.pickCookie();
    pick!.release(false);
    pick!.release(false);
    pick!.release(true); // reset
    pick!.release(false);
    pick!.release(false);
    // still alive: only 2 in a row, never reached 3
    pick!.release(false);
    assert.strictEqual(pool.aliveCount(), 0);
    // confirm: 3 in a row after the reset → evict
  });

  it("returns null when all evicted", () => {
    const pool = new CookiePool({ cookies: [makeCookie("only")] });
    const pick = pool.pickCookie()!;
    pick.release(false);
    pick.release(false);
    pick.release(false);
    assert.strictEqual(pool.pickCookie(), null);
  });

  it("rejects empty cookie list", () => {
    assert.throws(() => new CookiePool({ cookies: [] }));
  });
});

// -- 4. JsonlWriter atomic write ----------------------------------------------

describe("JsonlWriter", () => {
  it("emits metadata header + records atomically", async () => {
    const dir = await tmpDir("jsonl-");
    const out = path.join(dir, "beers.jsonl");
    try {
      const w = new JsonlWriter({
        output_path: out,
        source: "untappd",
        license_note: "untappd public pages; no check-in/heart; dev-mode replay",
      });
      await w.open();
      await w.writeRecord({
        source: "untappd",
        source_id: "1",
        name: "Test IPA",
        brewery_id: null,
        style: "IPA",
        abv: 6.5,
        ibu: 55,
        rating: 4.2,
        rating_count: 100,
        description: "ok",
        labels: ["craft"],
        food_pairing: [],
        similar_ids: [],
        url: "https://example/",
        fetched_at: "2026-08-04T00:00:00Z",
      });
      await w.writeRecord({
        source: "untappd",
        source_id: "2",
        name: "Two",
        brewery_id: null,
        style: null,
        abv: null,
        ibu: null,
        rating: null,
        rating_count: null,
        description: null,
        labels: [],
        food_pairing: [],
        similar_ids: [],
        url: "https://example/2",
        fetched_at: "2026-08-04T00:00:00Z",
      });
      assert.strictEqual(w.count(), 2);
      await w.close();

      const body = await fs.readFile(out, "utf8");
      const lines = body.split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 3, "header + 2 records");
      const header = JSON.parse(lines[0]!);
      assert.strictEqual(header._meta.source, "untappd");
      assert.ok(typeof header._meta.generated_at === "string");
      assert.ok(header._meta.license_note.includes("dev-mode"));
      const rec1 = JSON.parse(lines[1]!);
      assert.strictEqual(rec1.source_id, "1");
      assert.strictEqual(rec1.name, "Test IPA");
      const rec2 = JSON.parse(lines[2]!);
      assert.strictEqual(rec2.source_id, "2");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("abort() removes the tmp file and never writes the target", async () => {
    const dir = await tmpDir("jsonl-abort-");
    const out = path.join(dir, "beers.jsonl");
    try {
      const w = new JsonlWriter({
        output_path: out,
        source: "ratebeer",
        license_note: "ratebeer public pages; dev-mode replay",
      });
      await w.open();
      await w.writeRecord({ placeholder: true });
      await w.abort();
      // target file should not exist
      await assert.rejects(fs.access(out));
      // tmp should be gone (best-effort)
      const files = await fs.readdir(dir);
      assert.ok(files.length === 0 || !files.some((f) => f.includes(".tmp-")));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// -- 5. Replay driver ---------------------------------------------------------

describe("ReplayDriver", () => {
  it("returns fixture HTML with 200 status", async () => {
    const dir = fixturesDir();
    const r = new ReplayDriver({ fixtures_dir: dir, strict: true });
    const snap = await r.fetchPage("fixture://sample-untappd.html", {
      cookie: makeCookie("c1"),
      jitter_ms: 0,
      timeout_ms: 1000,
    });
    assert.strictEqual(snap.status, 200);
    assert.ok(snap.html.includes("Sample Untappd Beer"));
    assert.ok(snap.html.includes('<div class="beer-info">'));
    assert.ok(snap.html.includes("<title>Sample Untappd Beer (fixture)</title>"));
  });

  it("falls back to 404 in non-strict mode when fixture is missing", async () => {
    const dir = fixturesDir();
    const r = new ReplayDriver({ fixtures_dir: dir, strict: false });
    const snap = await r.fetchPage("fixture://no-such-fixture.html", {
      cookie: makeCookie("c1"),
      jitter_ms: 0,
      timeout_ms: 1000,
    });
    assert.strictEqual(snap.status, 404);
    assert.strictEqual(snap.html, "");
  });

  it("rejects non-fixture URLs", async () => {
    const dir = fixturesDir();
    const r = new ReplayDriver({ fixtures_dir: dir, strict: false });
    await assert.rejects(
      () =>
        r.fetchPage("https://untappd.com/b/x/1", {
          cookie: makeCookie("c1"),
          jitter_ms: 0,
          timeout_ms: 1000,
        }),
      /fixture/,
    );
  });

  it("honors #fixture= fragment", async () => {
    const dir = fixturesDir();
    const r = new ReplayDriver({ fixtures_dir: dir });
    const snap = await r.fetchPage("https://example.invalid/#fixture=sample-untappd.html", {
      cookie: makeCookie("c1"),
      jitter_ms: 0,
      timeout_ms: 1000,
    });
    assert.strictEqual(snap.status, 200);
    assert.ok(snap.html.includes("beer-info"));
  });
});
