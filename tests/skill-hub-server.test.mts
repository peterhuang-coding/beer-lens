/**
 * Tests for Skill Hub server — subprocess helpers + route table shape.
 *
 * Run via: node --experimental-strip-types --test tests/skill-hub-server.test.mts
 *
 * We don't spawn an actual HTTP server in tests (would need a port). Instead
 * we verify the static scan helpers and the route key shape so a typo breaks
 * the build before runtime.
 */

// @ts-nocheck — strip-types module resolution tolerates untyped this
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "skill-hub-server.mjs");
const HTML = path.join(ROOT, "data", "dashboard.html");
const CSS = path.join(ROOT, "data", "dashboard.css");
const JS = path.join(ROOT, "data", "dashboard.js");

describe("Skill Hub: static files exist", () => {
  it("server script exists", async () => {
    const txt = await readFile(SERVER, "utf8");
    assert.ok(txt.includes("createServer"), "server must import createServer");
    assert.ok(txt.includes("8888"), "default port must be 8888");
  });

  it("dashboard.html exists with all 4 panels", async () => {
    const txt = await readFile(HTML, "utf8");
    assert.match(txt, /id="panel-crawl"/);
    assert.match(txt, /id="panel-db"/);
    assert.match(txt, /id="panel-apis"/);
    assert.match(txt, /id="panel-features"/);
  });

  it("dashboard.css exists", async () => {
    const txt = await readFile(CSS, "utf8");
    assert.match(txt, /--bg:\s*#/);
    assert.match(txt, /\.kpi/);
  });

  it("dashboard.js defines all 4 render functions", async () => {
    const txt = await readFile(JS, "utf8");
    assert.match(txt, /async function renderCrawlLog/);
    assert.match(txt, /async function renderDbStats/);
    assert.match(txt, /async function renderApis/);
    assert.match(txt, /async function renderFeatures/);
  });
});

describe("Skill Hub: route registration", () => {
  it("registers all expected endpoints", async () => {
    const txt = await readFile(SERVER, "utf8");
    const expected = [
      "GET /",
      "GET /data/dashboard.css",
      "GET /data/dashboard.js",
      "GET /api/stats",
      "GET /api/health",
      "GET /api/crawl-log",
      "GET /api/features",
      "GET /api/apis",
      "GET /api/snapshots",
    ];
    for (const ep of expected) {
      assert.ok(
        txt.includes(`"${ep}"`),
        `route key missing in server: ${ep}`,
      );
    }
  });
});