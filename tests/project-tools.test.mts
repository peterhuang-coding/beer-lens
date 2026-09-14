import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const source = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "beer-tools-clean-"));
for (const file of [
  "scripts",
  "lib/skills",
  "data/chinese-craft-beers.json",
  "data/skill-manifest.json",
  ".claude/skills/beer-lens",
  "skills/beer-lens",
  "package.json",
]) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(path.join(source, file), target, { recursive: true });
}
after(() => rmSync(root, { recursive: true, force: true }));
function run(script: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts", script), ...args],
    { cwd: tmpdir(), encoding: "utf8", timeout: 15000 },
  );
}
test("agent check works without private SQLite/Python files", () => {
  const r = run("agent.mjs", ["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /All required items present/);
});
test("agent rejects unknown flags before invoking Claude", () => {
  const r = run("agent.mjs", ["--unknown"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown/);
});
test("portable skill decision helper works outside the repository cwd", () => {
  const input = JSON.stringify({ constraints: { maxPrice: 50 }, offers: [{ index: 1, name: "A", price: 45, volumeMl: 330 }] });
  const r = spawnSync(process.execPath, [path.join(root, "skills/beer-lens/scripts/decide-menu.mjs")], {
    cwd: tmpdir(), input, encoding: "utf8", timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).recommendations[0].index, 1);
});
test("crawler prints only JSON, honors zero, and resolves project data outside CWD", () => {
  const r = run("always-on-crawler.mjs", ["--print", "--limit", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).targets.length, 0);
});
test("crawler rejects invalid limits", () => {
  for (const n of ["-1", "x", "1.5"]) {
    const r = run("always-on-crawler.mjs", ["--print", "--limit", n]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /limit/);
  }
});
test("crawler outputs a bounded seed round without private database", () => {
  const r = run("always-on-crawler.mjs", ["--print", "--limit", "2"]);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.targets.length, 2);
  assert.equal(d.targets[0].priority, "p2_seed");
});
test("inspector reports actual portable data and unknown regression status", () => {
  const r = run("skill-inspector.mjs", ["--print"]);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.phases.skills.builtin_count, 8);
  assert.equal(d.phases.regression.status, "not_run");
  assert.equal(d.phases.regression.passed, null);
  assert.equal(d.phases.state.stats.source, "data/chinese-craft-beers.json");
  assert.ok(d.phases.state.stats.total_beers > 0);
  assert.equal(d.phases.state.stats.verified_entries, 0);
});

test("short flags cannot be consumed as values", () => {
  for (const [script, args] of [
    ["always-on-crawler.mjs", ["--output", "-p"]],
    ["skill-inspector.mjs", ["--output", "-p"]],
    ["agent.mjs", ["--query", "-q"]],
  ] as const) {
    const r = run(script, [...args]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Missing/);
  }
});
test("round requires a non-negative integer", () => {
  const r = run("always-on-crawler.mjs", ["--print", "--round", "banana"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /round/);
});
