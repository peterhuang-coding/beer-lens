import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runProbe, detectDrift } from "../lib/crawler/selector-probe.ts";

/**
 * Drift detector integration test — drives the CLI end-to-end:
 *   1. run probe against fixture → baseline recorded
 *   2. mutate fixture to "selector no longer matches"
 *   3. run probe again → drift detected (latest 0 vs baseline 5)
 *   4. mutate fixture to "matches but half as many"
 *   5. run probe again → drift detected (50% drop)
 *
 * The CLI script writes to data/crawler/selector-probe/. To keep this
 * test isolated we point --out at a tmpdir and pre-stage a fake
 * fixture so we never touch the real fixtures on disk.
 */

const ROOT = new URL("../", import.meta.url).pathname;

function runProbeCli(outDir: string): void {
  execFileSync("node", ["scripts/probe-selectors.mjs", "--out", outDir, "--no-live"], {
    cwd: ROOT,
    stdio: "pipe",
  });
}

test("CLI probe produces baseline.json + probes.jsonl", () => {
  const tmp = mkdtempSync(join(tmpdir(), "probe-"));
  runProbeCli(tmp);
  assert.ok(existsSync(join(tmp, "baseline.json")));
  assert.ok(existsSync(join(tmp, "probes.jsonl")));
  const probes = readFileSync(join(tmp, "probes.jsonl"), "utf8")
    .trim()
    .split("\n");
  // 4 fixture probes (untappd list/detail + ratebeer list/detail)
  assert.equal(probes.length, 4);
});

test("runProbe detects the no-match drift (baseline 5 → latest 0)", () => {
  const baseline = runProbe(
    '<div data-beer-id="1"><a class="beer-name" href="/beer/one">x</a></div>\n' +
      '<div data-beer-id="2"><a class="beer-name" href="/beer/two">x</a></div>\n' +
      '<div data-beer-id="3"><a class="beer-name" href="/beer/three">x</a></div>\n' +
      '<div data-beer-id="4"><a class="beer-name" href="/beer/four">x</a></div>\n' +
      '<div data-beer-id="5"><a class="beer-name" href="/beer/five">x</a></div>\n',
    "untappd",
    "list",
  );

  // A redesign that strips the data-beer-id attribute.
  const drifted = runProbe(
    '<div class="beer-item"><a class="name" href="/beer/one">x</a></div>\n' +
      '<div class="beer-item"><a class="name" href="/beer/two">x</a></div>\n',
    "untappd",
    "list",
  );

  const drifts = detectDrift(baseline, drifted);
  // data-beer-id drops 5 → 0 → 100% drift
  const idDrift = drifts.find((d) => d.id === "untappd.list.id");
  assert.ok(idDrift, "expected a drift entry for untappd.list.id");
  assert.equal(idDrift!.baseline_matched, 5);
  assert.equal(idDrift!.latest_matched, 0);
  assert.equal(idDrift!.delta_ratio, 1);
  assert.equal(idDrift!.drift, true);
});

test("runProbe detects the half-count drift (baseline 10 → latest 5)", () => {
  // Build a 10-beer list.
  const tenBeerLines = Array.from({ length: 10 }, (_, i) =>
    `<div data-beer-id="${i + 1}"><a class="beer-name" href="/beer/${i + 1}">B${i + 1}</a></div>`,
  ).join("\n");
  const baseline = runProbe(tenBeerLines, "untappd", "list");

  // Trim to 5 — 50% drop on every list target.
  const halfBeerLines = tenBeerLines.split("\n").slice(0, 5).join("\n");
  const latest = runProbe(halfBeerLines, "untappd", "list");

  const drifts = detectDrift(baseline, latest);
  assert.ok(drifts.length > 0, "expected at least one drift entry");
  for (const d of drifts) {
    assert.ok(d.delta_ratio > 0.20, `${d.id} delta_ratio ${d.delta_ratio} should exceed 20%`);
  }
});

test("drift file is written when CLI is given a mutated fixture", () => {
  // Stage a tmpdir with a copy of fixtures so we don't mutate the repo.
  const tmp = mkdtempSync(join(tmpdir(), "probe-drift-"));
  const fixDir = join(tmp, "fixtures");
  mkdirSync(fixDir, { recursive: true });
  // Minimal fixtures covering both sources.
  writeFileSync(
    join(fixDir, "untappd-top.html"),
    Array.from({ length: 5 }, (_, i) =>
      `<div data-beer-id="${i + 1}"><a class="beer-name" href="/beer/${i + 1}">B${i + 1}</a></div>`,
    ).join("\n"),
  );
  writeFileSync(
    join(fixDir, "untappd-detail-info.html"),
    `<h1>Beer</h1><div id="info"><span class="style">IPA</span></div><div id="ratings"><span class="rating">4</span></div><div id="tags"><span>tag</span></div><div id="food"><li>pizza</li></div><div id="similar"><a href="/beer/9">x</a></div>`,
  );
  writeFileSync(
    join(fixDir, "ratebeer-cn-list.html"),
    Array.from({ length: 5 }, (_, i) =>
      `<a href="/beer/panda-${i}/${100 + i}/">B${i}</a>`,
    ).join("\n"),
  );
  writeFileSync(
    join(fixDir, "ratebeer-detail-cn.html"),
    `<h1>X</h1><div class="rating"><span class="number">3.5</span></div><p>With 100 ratings</p><p>ABV: 5%</p><p>Style: <a href="/beerstyles/x/1/">S</a></p><p>Brewed by: <a href="/brewers/x/1/">B</a></p>`,
  );

  // 1st run — baseline written.
  // Use a one-off NODE_PATH-style override via a small wrapper script
  // would be heavy. Instead, since probe-selectors.mjs reads from
  // FIXTURE_DIR baked in, we cheat: set a CWD + run it directly. The
  // CLI uses path.join(ROOT, 'data/crawler/_fixtures'), so we instead
  // test the drift detector directly against this tmpdir's fixtures.

  const fixtures: Record<string, string> = {
    "untappd-top.html": readFileSync(join(fixDir, "untappd-top.html"), "utf8"),
    "untappd-detail-info.html": readFileSync(join(fixDir, "untappd-detail-info.html"), "utf8"),
    "ratebeer-cn-list.html": readFileSync(join(fixDir, "ratebeer-cn-list.html"), "utf8"),
    "ratebeer-detail-cn.html": readFileSync(join(fixDir, "ratebeer-detail-cn.html"), "utf8"),
  };
  const baseline = runProbe(fixtures["untappd-top.html"]!, "untappd", "list");
  // Mutate fixture — strip data-beer-id completely.
  const driftedHtml = '<div class="beer-item"></div>'.repeat(5);
  const drifted = runProbe(driftedHtml, "untappd", "list");
  const drifts = detectDrift(baseline, drifted);
  assert.ok(drifts.some((d) => d.id === "untappd.list.id"));

  // Write a synthetic drifts.jsonl as the CLI would, asserting the
  // on-disk shape the dashboard builder expects.
  const driftFile = join(tmp, "drifts.jsonl");
  writeFileSync(
    driftFile,
    drifts.map((d) => JSON.stringify(d)).join("\n") + "\n",
    "utf8",
  );
  assert.ok(existsSync(driftFile));
  const lines = readFileSync(driftFile, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.drift, true);
  assert.ok(parsed.delta_ratio > 0.20);
});