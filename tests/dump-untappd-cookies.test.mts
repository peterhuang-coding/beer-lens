import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

// ── 1. file exists and is non-trivial ───────────────────────────────────

test("scripts/dump-untappd-cookies.mjs exists", () => {
  assert.ok(existsSync("scripts/dump-untappd-cookies.mjs"));
});

test("script is > 50 lines and < 250 lines (sanity bound)", () => {
  const lines = readFileSync("scripts/dump-untappd-cookies.mjs", "utf8")
    .split("\n").length;
  assert.ok(lines > 50, `expected > 50 LoC, got ${lines}`);
  assert.ok(lines < 250, `expected < 250 LoC, got ${lines}`);
});

// ── 2. syntax-checks clean ──────────────────────────────────────────────

test("node --check passes (no syntax errors)", () => {
  const r = spawnSync("node", ["--check", "scripts/dump-untappd-cookies.mjs"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `node --check failed:\n${r.stderr}`);
});

// ── 3. fails gracefully when CDP port is unreachable ────────────────────

test("exits non-zero with helpful stderr when Chrome debug port is closed", () => {
  // Ensure nothing is listening on 9222 in this test sandbox.
  // If something IS, we just skip — we don't want to disturb user's Chrome.
  let portBusy = false;
  try {
    execFileSync("lsof", ["-ti:9222", "-sTCP:LISTEN"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    portBusy = true;
  } catch {
    portBusy = false;
  }
  if (portBusy) {
    console.log("[skip] port 9222 already in use; can't test failure path");
    return;
  }

  const r = spawnSync("node", ["scripts/dump-untappd-cookies.mjs"], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.notEqual(r.status, 0, "expected non-zero exit when CDP unreachable");
  assert.match(
    r.stderr,
    /Chrome 远程调试端口.*不通/,
    `expected helpful stderr, got:\n${r.stderr}`,
  );
});

// ── 4. cookie hygiene: NEVER writes cookie values to disk ───────────────

test("script body does not write cookies anywhere (no fs write of cookie data)", () => {
  const src = readFileSync("scripts/dump-untappd-cookies.mjs", "utf8");
  // No fs.writeFile, no fs.appendFile, no path joins, no JSON.stringify of a Map
  assert.ok(!src.includes("writeFile"), "no fs.writeFile in cookie script");
  assert.ok(!src.includes("appendFile"), "no fs.appendFile in cookie script");
  // Output is stdout only — script uses console.log for the export line
  assert.ok(src.includes("console.log"), "uses console.log for export line");
});

test("script body never imports fs write APIs (cookie hygiene)", () => {
  const src = readFileSync("scripts/dump-untappd-cookies.mjs", "utf8");
  // Risk: any code path that writes cookie bytes to disk.
  // CDP HTTP paths like /json/version are fine — they're not file writes.
  for (const bad of [
    "writeFile",
    "appendFile",
    "createWriteStream",
    "fs.writeFileSync",
  ]) {
    assert.ok(
      !src.includes(bad),
      `unexpected disk-write reference: ${bad}`,
    );
  }
});

// ── 5. only the export line goes to stdout ──────────────────────────────

test("main() output path is exactly one console.log on the export line", () => {
  const src = readFileSync("scripts/dump-untappd-cookies.mjs", "utf8");
  // Count lines that begin (after whitespace) with console.log(  →  exactly 1
  const lines = src.split("\n");
  const logLines = lines.filter((l) =>
    /^\s*console\.log\(/.test(l),
  );
  assert.equal(
    logLines.length,
    1,
    `expected exactly 1 console.log line, got ${logLines.length}:\n${logLines.join("\n")}`,
  );
  assert.ok(
    logLines[0].includes("UNTAPPD_DEV_COOKIE"),
    `console.log line must reference UNTAPPD_DEV_COOKIE:\n${logLines[0]}`,
  );
});

// ── 6. regression: does NOT call CDP /json/new (Chrome 150+ returns 405) ─

test("script does NOT call CDP /json/new (regression: Chrome 150+ returns 405)", () => {
  const src = readFileSync("scripts/dump-untappd-cookies.mjs", "utf8");
  // We must not call /json/new via HTTP — use macOS `open` instead.
  assert.ok(
    !src.includes("/json/new"),
    "found /json/new reference — must use macOS `open` to avoid 405",
  );
  // And we DO use macOS `open` for tab creation:
  assert.ok(
    src.includes('execFileSync("open"'),
    "expected execFileSync('open', ...) to create new tab",
  );
});

test("script falls back through `open` + retry loop (waits for new tab)", () => {
  const src = readFileSync("scripts/dump-untappd-cookies.mjs", "utf8");
  // After open, the script should re-list targets to find the new tab.
  assert.ok(
    src.includes("json/list") && src.includes("setTimeout"),
    "expected re-list + retry loop after opening new tab",
  );
});