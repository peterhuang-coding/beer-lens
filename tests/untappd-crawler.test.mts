/**
 * Tests for untappd-crawler.mjs argument parsing + help output.
 * Does NOT actually run a browser (would hit Cloudflare).
 *
 * Run via: node --experimental-strip-types --test tests/untappd-crawler.test.mts
 */

// @ts-nocheck
import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "untappd-crawler.mjs");

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SCRIPT, ...args], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", reject);
  });
}

describe("untappd-crawler --help", () => {
  it("shows the Cloudflare caveat", async () => {
    const r = await run(["--help"]);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /Cloudflare/);
    assert.match(r.stdout, /--cookies/);
    assert.match(r.stdout, /--cdp/);
    assert.match(r.stdout, /--headed/);
    assert.match(r.stdout, /--user-data-dir/);
  });
});

describe("untappd-crawler argument validation", () => {
  it("rejects unknown args", async () => {
    const r = await run(["--bogus-flag"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /Unknown arg/);
  });

  it("errors when no target given", async () => {
    const r = await run([]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /Need --search, --url, or --queryfile/);
  });
});