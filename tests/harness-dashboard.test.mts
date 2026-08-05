import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ── 1. build script exists and emits the expected HTML ───────────────────

test("build-harness-dashboard.mjs exists and is executable", () => {
  assert.ok(existsSync("scripts/build-harness-dashboard.mjs"));
});

test("node scripts/build-harness-dashboard.mjs writes docs/harness-platform.html", () => {
  execFileSync("node", ["scripts/build-harness-dashboard.mjs"], { stdio: "pipe" });
  assert.ok(existsSync("docs/harness-platform.html"));
});

// ── 2. regenerated HTML reflects disk truth ──────────────────────────────

test("HTML output contains the 8 builtin skill ids", async () => {
  const html = await readFile("docs/harness-platform.html", "utf8");
  for (const id of [
    "menu_recommend",
    "follow_up_filter",
    "tasting_feedback",
    "profile_query",
    "beer_knowledge",
    "label_check",
    "memory_correction",
    "unclear",
  ]) {
    assert.ok(html.includes(id), `missing skill id: ${id}`);
  }
});

test("HTML output reflects manifest + handlerFile counts", async () => {
  const html = await readFile("docs/harness-platform.html", "utf8");
  // 8 builtin + 7 executors (menu_recommend and follow_up_filter share recommend/execute.ts)
  assert.ok(/<b>8<\/b> builtin skills/.test(html));
  assert.ok(/<b>7<\/b> executors/.test(html));
});

test("HTML output reflects crawler modules and fixtures", async () => {
  const html = await readFile("docs/harness-platform.html", "utf8");
  assert.ok(/<b>17<\/b> modules/.test(html));
  assert.ok(/<b>9<\/b> fixtures/.test(html));
  for (const m of [
    "contracts.ts",
    "puppeteer-driver.ts",
    "untappd.ts",
    "ratebeer.ts",
    "cli.ts",
  ]) {
    assert.ok(html.includes(m), `missing crawler module: ${m}`);
  }
});

test("HTML output is well-formed (no stray template literals)", async () => {
  const html = await readFile("docs/harness-platform.html", "utf8");
  assert.ok(!html.includes("${"), "leftover template literal in HTML");
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.endsWith("</html>\n"));
});

test("HTML output is non-trivial (>5KB)", async () => {
  const s = await stat("docs/harness-platform.html");
  assert.ok(s.size > 5000, `expected > 5KB, got ${s.size}`);
});

// ── 3. Next.js /harness route exists ─────────────────────────────────────

test("app/harness/page.tsx exists for the Next.js route", () => {
  assert.ok(existsSync("app/harness/page.tsx"));
});

// ── 4. npm script registered ─────────────────────────────────────────────

test("package.json exposes harness:dashboard script", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.scripts["harness:dashboard"], "node scripts/build-harness-dashboard.mjs");
});
