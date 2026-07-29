#!/usr/bin/env node
/**
 * skill-hub-server.mjs — Tiny HTTP server that serves the Skill Hub dashboard
 * for the beer-lens project.
 *
 * What it serves:
 *   GET /                  → data/dashboard.html (single-page UI)
 *   GET /data/dashboard.{css,js}  → static assets
 *   GET /api/stats         → runs harness.py stats
 *   GET /api/health        → runs harness.py health
 *   GET /api/crawl-log     → reads data/crawl-log.jsonl (or [])
 *   GET /api/features      → runs pm-feature.sh list
 *   GET /api/apis          → static scan of harness.py + package.json scripts
 *   GET /api/snapshots     → lists data/snapshots/*.json
 *
 * Usage:
 *   node scripts/skill-hub-server.mjs                  # port 8888
 *   node scripts/skill-hub-server.mjs --port 9000      # custom port
 *   PORT=9000 node scripts/skill-hub-server.mjs        # env var
 *
 * Stop with Ctrl-C. No external deps.
 */

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const HARNESS = path.join(ROOT, ".beer-data", "harness.py");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const PM_FEATURE_SH = process.env.PM_FEATURE_SH
  || path.join(process.env.HOME || "", ".claude/skills/pm-orchestrator/scripts/pm-feature.sh");

function parseArgs(argv) {
  const args = { port: Number(process.env.PORT) || 8888, host: process.env.HOST || "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") args.port = parseInt(argv[++i]) || args.port;
    else if (argv[i] === "--host") args.host = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`skill-hub-server.mjs — Beer-Lens Skill Hub dashboard

Usage:
  node scripts/skill-hub-server.mjs [--port 8888] [--host 127.0.0.1]

Endpoints:
  GET /                  dashboard.html
  GET /api/stats         harness.py stats
  GET /api/health        harness.py health
  GET /api/crawl-log     data/crawl-log.jsonl (empty array if missing)
  GET /api/features      pm-feature.sh list
  GET /api/apis          scan of package.json scripts + harness.py commands
  GET /api/snapshots     list data/snapshots/*.json
`);
}

// ── Subprocess helpers ──────────────────────────────────────────

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs || 10_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${path.basename(cmd)} exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function getStats() {
  const { stdout } = await runProcess("python3", [HARNESS, "stats"], { timeoutMs: 15_000 });
  return JSON.parse(stdout);
}

async function getHealth() {
  const { stdout } = await runProcess("python3", [HARNESS, "health"], { timeoutMs: 15_000 });
  return JSON.parse(stdout);
}

async function getCrawlLog() {
  const logPath = path.join(DATA_DIR, "crawl-log.jsonl");
  try {
    const text = await readFile(logPath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); }
      catch { return { _malformed: line }; }
    });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function getFeatures() {
  try {
    const { stdout } = await runProcess(PM_FEATURE_SH, ["list"], { timeoutMs: 10_000 });
    return stdout;
  } catch (err) {
    // Don't fail the whole page if pm-feature isn't reachable — return empty.
    return { error: err.message, features: [] };
  }
}

async function getApis() {
  // Static scan: package.json scripts + harness.py subcommands
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  const scripts = Object.entries(pkg.scripts || {}).map(([name, cmd]) => ({
    name, cmd, source: "package.json",
  }));
  // Read harness.py usage line
  let harnessCmds = [];
  try {
    const harnessSrc = await readFile(HARNESS, "utf8");
    const usageMatch = harnessSrc.match(/Usage:\s*\n([\s\S]*?)\n"""/);
    if (usageMatch) {
      const lines = usageMatch[1].split("\n");
      for (const line of lines) {
        const m = line.match(/^\s*python3 harness\.py\s+(\S+)/);
        if (m) harnessCmds.push({ name: m[1], source: "harness.py" });
      }
    }
  } catch { /* ignore */ }
  return { scripts, harnessCmds };
}

async function getSnapshots() {
  const dir = path.join(DATA_DIR, "snapshots");
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 30);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// ── HTTP server ─────────────────────────────────────────────────

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function htmlResponse(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function notFound(res) {
  jsonResponse(res, 404, { error: "not found" });
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { error: "method not allowed" });
}

async function serveStatic(res, relPath, contentType) {
  try {
    const abs = path.join(DATA_DIR, relPath);
    if (!abs.startsWith(DATA_DIR)) return notFound(res); // path traversal guard
    const body = await readFile(abs, "utf8");
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
  } catch {
    notFound(res);
  }
}

const routes = {
  "GET /": async (req, res) => {
    const html = await readFile(path.join(DATA_DIR, "dashboard.html"), "utf8");
    htmlResponse(res, 200, html);
  },
  "GET /data/dashboard.css": async (req, res) => serveStatic(res, "dashboard.css", "text/css; charset=utf-8"),
  "GET /data/dashboard.js": async (req, res) => serveStatic(res, "dashboard.js", "application/javascript; charset=utf-8"),
  "GET /api/stats": async (req, res) => {
    try { jsonResponse(res, 200, await getStats()); }
    catch (err) { jsonResponse(res, 500, { error: err.message }); }
  },
  "GET /api/health": async (req, res) => {
    try { jsonResponse(res, 200, await getHealth()); }
    catch (err) { jsonResponse(res, 500, { error: err.message }); }
  },
  "GET /api/crawl-log": async (req, res) => {
    try { jsonResponse(res, 200, await getCrawlLog()); }
    catch (err) { jsonResponse(res, 500, { error: err.message }); }
  },
  "GET /api/features": async (req, res) => {
    try { jsonResponse(res, 200, await getFeatures()); }
    catch (err) { jsonResponse(res, 500, { error: err.message }); }
  },
  "GET /api/apis": async (req, res) => {
    try { jsonResponse(res, 200, await getApis()); }
    catch (err) { jsonResponse(res, 500, { error: err.message }); }
  },
  "GET /api/snapshots": async (req, res) => {
    try { jsonResponse(res, 200, await getSnapshots()); }
    catch (err) { jsonResponse(res, 500, { error: err.message }); }
  },
};

const server = createServer(async (req, res) => {
  const key = `${req.method} ${req.url}`;
  const handler = routes[key];
  if (!handler) {
    if (req.method !== "GET") return methodNotAllowed(res);
    return notFound(res);
  }
  try {
    await handler(req, res);
  } catch (err) {
    jsonResponse(res, 500, { error: err.message });
  }
});

// ── Main ────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  server.listen(args.port, args.host, () => {
    console.log(`🍺 Skill Hub → http://${args.host}:${args.port}/`);
    console.log(`   Root: ${ROOT}`);
    console.log(`   Press Ctrl-C to stop.`);
  });
}

main();