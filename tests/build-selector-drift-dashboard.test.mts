import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = new URL("../", import.meta.url).pathname;

test("build-selector-drift-dashboard.mjs exists", () => {
  assert.ok(existsSync(join(ROOT, "scripts/build-selector-drift-dashboard.mjs")));
});

test("dashboard build writes docs/selector-drift.html", () => {
  // ensure probe data exists so the dashboard has something to render
  execFileSync("node", ["scripts/probe-selectors.mjs", "--no-live"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  execFileSync("node", ["scripts/build-selector-drift-dashboard.mjs"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  assert.ok(existsSync(join(ROOT, "docs/selector-drift.html")));
});

test("dashboard HTML contains the selector matrix table", () => {
  const html = readFileSync(join(ROOT, "docs/selector-drift.html"), "utf8");
  assert.ok(html.includes("<table>"), "missing <table>");
  assert.ok(html.includes("untappd"), "missing untappd source heading");
  assert.ok(html.includes("ratebeer"), "missing ratebeer source heading");
  // Pick a few canonical probe target ids from PROBE_TARGETS.
  for (const id of [
    "untappd.list.item",
    "untappd.list.id",
    "untappd.detail.info",
    "ratebeer.list.beer-link",
    "ratebeer.detail.brewery",
  ]) {
    assert.ok(html.includes(id), `dashboard missing target: ${id}`);
  }
});

test("dashboard renders green/red status correctly with synthetic data", async () => {
  // Stage synthetic baseline + probes + drifts in a tmpdir and run the
  // build with that data by pointing the script at our staged data.
  const tmp = mkdtempSync(join(tmpdir(), "sel-drift-"));
  const dataDir = join(tmp, "data/crawler/selector-probe");
  const docsDir = join(tmp, "docs");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });

  writeFileSync(
    join(dataDir, "baseline.json"),
    JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      head: "deadbee",
      source: "fixture",
      targets: [
        { id: "untappd.list.id", matched: 5 },
        { id: "untappd.detail.info", matched: 1 },
        { id: "ratebeer.detail.brewery", matched: 1 },
      ],
    }),
  );
  writeFileSync(
    join(dataDir, "probes.jsonl"),
    JSON.stringify({
      ts: "2026-02-01T00:00:00Z",
      head: "cafef00",
      source: "untappd",
      surface: "list",
      url: "fixture://untappd-top.html",
      targets: [{ id: "untappd.list.id", name: "LIST_SELECTORS.id", matched: 0, sample: ["no-match"] }],
    }) + "\n",
  );
  writeFileSync(
    join(dataDir, "drifts.jsonl"),
    JSON.stringify({
      id: "untappd.list.id",
      source: "untappd",
      surface: "list",
      name: "LIST_SELECTORS.id",
      baseline_matched: 5,
      latest_matched: 0,
      delta_ratio: 1,
      ts: "2026-02-01T00:00:00Z",
      drift: true,
    }) + "\n",
  );

  // The build script reads from a hardcoded data path. To avoid
  // touching the real repo data, copy the staged files into the
  // real location, run the build, then restore.
  const realData = join(ROOT, "data/crawler/selector-probe");
  const realDocs = join(ROOT, "docs/selector-drift.html");
  const backupData = readFileSync(realDocs, "utf8");

  const { copyFileSync, rmSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(realData)) {
    rmSync(join(realData, f), { force: true });
  }
  for (const f of ["baseline.json", "probes.jsonl", "drifts.jsonl"]) {
    copyFileSync(join(dataDir, f), join(realData, f));
  }
  try {
    execFileSync("node", ["scripts/build-selector-drift-dashboard.mjs"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    const html = readFileSync(realDocs, "utf8");
    assert.ok(html.includes("DRIFT"), "expected a DRIFT status cell");
    assert.ok(html.includes("drift alerts") || html.includes("drift log"));
    assert.ok(/<td class="status drift">DRIFT/.test(html));
  } finally {
    writeFileSync(realDocs, backupData, "utf8");
    execFileSync("node", ["scripts/probe-selectors.mjs", "--no-live"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    execFileSync("node", ["scripts/build-selector-drift-dashboard.mjs"], {
      cwd: ROOT,
      stdio: "pipe",
    });
  }
});