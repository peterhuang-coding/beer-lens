/**
 * Tests for the skill-inspector script. Verifies report schema + key fields.
 *
 * Run via: node --experimental-strip-types --test tests/skill-inspector.test.mts
 *
 * The inspector depends on harness.py + lib/harness/skill-registry.ts in
 * the real project; we run it via spawn and parse the output JSON.
 */

// @ts-nocheck — strip-types module resolution tolerates untyped this
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "skill-inspector.mjs");

let report = null;

before(async () => {
  report = await runInspector();
});

function runInspector() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SCRIPT, "--print"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}: ${stderr.slice(0, 300)}`));
      // Find the report JSON by its known first key.
      const startMarker = '"generatedAt"';
      const start = stdout.indexOf(startMarker);
      if (start < 0) {
        return reject(new Error(`report marker not found; stdout first 500: ${stdout.slice(0, 500)}`));
      }
      // Walk backwards to find the opening brace before the marker.
      let jsonStart = stdout.lastIndexOf("{", start);
      try {
        resolve(JSON.parse(stdout.slice(jsonStart)));
      } catch (err) {
        reject(new Error(`parse error: ${err.message}; near marker: ${stdout.slice(jsonStart, jsonStart + 200)}`));
      }
    });
    proc.on("error", reject);
  });
}

describe("skill-inspector schema", () => {
  it("has summary with verdict, issues, cases, actions", () => {
    assert.ok(report.summary, "summary missing");
    assert.match(report.summary.verdict, /^(OK|DEGRADED|BROKEN)$/);
    assert.strictEqual(typeof report.summary.issues, "number");
    assert.strictEqual(typeof report.summary.cases, "number");
    assert.strictEqual(typeof report.summary.actions, "number");
  });

  it("has all 5 phases", () => {
    for (const p of ["state", "gaps", "skills", "regression", "proposals"]) {
      assert.ok(report.phases[p], `phase missing: ${p}`);
    }
  });
});

describe("skill-inspector: state phase", () => {
  it("stats has beer_cache", () => {
    const cache = report.phases.state.stats.beer_cache;
    assert.ok(cache, "beer_cache missing");
    assert.strictEqual(typeof cache.verified, "number");
    assert.ok(cache.verified >= 28, `expected ≥28 verified, got ${cache.verified}`);
  });

  it("warm_list returns array", () => {
    assert.ok(Array.isArray(report.phases.state.warm_list));
  });

  it("health is boolean", () => {
    assert.strictEqual(typeof report.phases.state.health.healthy, "boolean");
  });
});

describe("skill-inspector: gaps phase", () => {
  it("identifies current 2 warm_list gaps", () => {
    const gaps = report.phases.gaps.missing.map((m) => `${m.name}|${m.brewery}`);
    assert.ok(gaps.some((g) => g.startsWith("Sleep|")));
    assert.ok(gaps.some((g) => g.startsWith("Bird Land NE IPA|")));
  });

  it("has source presence/absence enumeration", () => {
    assert.ok(Array.isArray(report.phases.gaps.sources_present));
    assert.ok(Array.isArray(report.phases.gaps.sources_missing));
    assert.ok(report.phases.gaps.sources_present.length > 0);
  });

  it("detects untappd_cache + ratebeer as present", () => {
    assert.ok(report.phases.gaps.sources_present.includes("untappd_cache"));
    assert.ok(report.phases.gaps.sources_present.includes("ratebeer"));
    assert.ok(report.phases.gaps.sources_present.includes("chinese_craft_seeds"));
    assert.ok(report.phases.gaps.sources_present.includes("websearch_realtime"));
  });
});

describe("skill-inspector: skills phase", () => {
  it("detects the 8 builtin skills from skill-registry.ts", () => {
    const ids = report.phases.skills.builtin_ids;
    const expected = [
      "menu_recommend", "follow_up_filter", "tasting_feedback",
      "profile_query", "beer_knowledge", "label_check",
      "memory_correction", "unclear",
    ];
    for (const id of expected) {
      assert.ok(ids.includes(id), `builtin missing: ${id}`);
    }
  });

  it("detects beer-lens project skill v6.0+", () => {
    const ps = report.phases.skills.project_skills;
    assert.ok(ps.some((s) => s.path.includes("beer-lens")));
  });
});

describe("skill-inspector: proposals phase", () => {
  it("generates P0 cases for warm_list gaps", () => {
    const cases = report.phases.proposals.cases;
    const p0 = cases.filter((c) => c.priority === "P0");
    assert.ok(p0.length >= 2, `expected ≥2 P0 cases, got ${p0.length}`);
    assert.ok(p0.some((c) => c.kind === "warm_list_gap"));
  });

  it("proposes at least 1 missing builtin skill", () => {
    const cases = report.phases.proposals.cases;
    assert.ok(cases.some((c) => c.kind === "skill_gap"));
  });

  it("every case has steps array", () => {
    for (const c of report.phases.proposals.cases) {
      assert.ok(Array.isArray(c.steps), `case ${c.kind} missing steps`);
      assert.ok(c.steps.length > 0, `case ${c.kind} has empty steps`);
    }
  });
});