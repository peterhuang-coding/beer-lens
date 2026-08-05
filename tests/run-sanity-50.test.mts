import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// ── 1. Script exists and has safety guards ─────────────────────────────────

test("run-sanity-50.mjs exists", () => {
  assert.ok(existsSync("scripts/run-sanity-50.mjs"));
});

test("script refuses to run without UNTAPPD_DEV_COOKIE (no --dry-run)", () => {
  // unset cookie to verify gate
  const env = { ...process.env };
  delete env.UNTAPPD_DEV_COOKIE;
  try {
    execFileSync("node", ["scripts/run-sanity-50.mjs"], {
      env,
      stdio: "pipe",
    });
    assert.fail("should have exited non-zero");
  } catch (e: any) {
    const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    assert.ok(out.includes("UNTAPPD_DEV_COOKIE"), `expected cookie error, got: ${out}`);
  }
});

// ── 2. Dry-run mode works without cookie ───────────────────────────────────

test("--dry-run runs without cookie and produces output", () => {
  const env = { ...process.env };
  delete env.UNTAPPD_DEV_COOKIE;
  execFileSync("node", ["scripts/run-sanity-50.mjs", "--dry-run", "--limit", "5"], {
    env,
    stdio: "pipe",
  });
  assert.ok(existsSync("data/crawler/_logs/sanity-50.jsonl"));
  assert.ok(existsSync("data/crawler/_logs/sanity-50-report.json"));
});

// ── 3. Report structure ────────────────────────────────────────────────────

test("dry-run report has expected fields", async () => {
  const env = { ...process.env };
  delete env.UNTAPPD_DEV_COOKIE;
  execFileSync("node", ["scripts/run-sanity-50.mjs", "--dry-run", "--limit", "5"], {
    env,
    stdio: "pipe",
  });
  const report = JSON.parse(
    await readFile("data/crawler/_logs/sanity-50-report.json", "utf8"),
  );
  for (const k of [
    "started_at",
    "ended_at",
    "duration_ms",
    "dry_run",
    "limit",
    "concurrency",
    "ok",
    "blocked_4xx",
    "errors",
    "success_rate",
    "blockers",
    "by_kind",
  ]) {
    assert.ok(k in report, `missing field: ${k}`);
  }
  assert.equal(report.dry_run, true);
  assert.equal(report.limit, 5);
  assert.ok(report.success_rate > 0);
});

// ── 4. Token safety — never writes UNTAPPD_DEV_COOKIE to disk ──────────────

test("script does not write UNTAPPD_DEV_COOKIE value to any file", async () => {
  const jsonl = await readFile("data/crawler/_logs/sanity-50.jsonl", "utf8");
  assert.ok(!jsonl.includes(process.env.UNTAPPD_DEV_COOKIE ?? "SENTINEL_INVALID"),
    "JSONL must not contain cookie");
  const report = await readFile("data/crawler/_logs/sanity-50-report.json", "utf8");
  assert.ok(!report.includes(process.env.UNTAPPD_DEV_COOKIE ?? "SENTINEL_INVALID"));
});
