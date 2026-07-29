#!/usr/bin/env node
/**
 * agent.mjs — Single entry point for the beer-lens Agent.
 *
 * Bundles every skill, harness, and script into one launchable surface.
 * Two modes:
 *
 *   1. Interactive (default): launches Claude Code in CWD with the
 *      beer-lens skill loaded and bypassPermissions on. Use for back-and-forth
 *      Q&A, crawler rounds, and ad-hoc exploration.
 *
 *   2. One-shot (`--query "<text>"` or positional arg): runs Claude in
 *      non-interactive mode (`claude -p`) and prints the response. Use for
 *      CI, automation, or scripted invocations.
 *
 * Usage:
 *   node scripts/agent.mjs                          # interactive
 *   node scripts/agent.mjs --query "Sleep 怎么样"    # one-shot
 *   node scripts/agent.mjs "Sleep 怎么样"            # one-shot (positional)
 *   node scripts/agent.mjs --check                  # show what's bundled
 *   node scripts/agent.mjs --tools                  # list tools/sources
 *   node scripts/agent.mjs --crawler                # shortcut: run crawler round
 *   node scripts/agent.mjs --inspector              # shortcut: run inspector
 *   node scripts/agent.mjs --hub [--port 8888]      # shortcut: start Skill Hub
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── What's bundled ──────────────────────────────────────────────

const BUNDLE = [
  { kind: "skill",     name: "beer-lens.md",          path: ".claude/skills/beer-lens.md",         required: true  },
  { kind: "harness",   name: "harness.py",            path: ".beer-data/harness.py",                required: true  },
  { kind: "harness",   name: "lookup.py",             path: ".beer-data/lookup.py",                 required: true  },
  { kind: "script",    name: "always-on-crawler.mjs", path: "scripts/always-on-crawler.mjs",        required: false },
  { kind: "script",    name: "skill-hub-server.mjs",  path: "scripts/skill-hub-server.mjs",         required: false },
  { kind: "script",    name: "skill-inspector.mjs",   path: "scripts/skill-inspector.mjs",          required: false },
  { kind: "data",      name: "beer.db",               path: ".beer-data/beer.db",                   required: true  },
  { kind: "data",      name: "chinese-craft-beers",   path: "data/chinese-craft-beers.json",        required: false },
  { kind: "registry",  name: "skill-registry.ts",     path: "lib/harness/skill-registry.ts",        required: false },
];

function checkBundle() {
  const results = BUNDLE.map((b) => ({
    ...b,
    present: existsSync(path.join(ROOT, b.path)),
    size: existsSync(path.join(ROOT, b.path)) ? statSync(path.join(ROOT, b.path)).size : 0,
  }));
  return results;
}

function printCheck() {
  const results = checkBundle();
  console.log(`🍺 beer-lens Agent — bundled surface\n`);
  console.log(`  CWD: ${ROOT}\n`);
  for (const r of results) {
    const mark = r.present ? (r.required ? "✅" : "✓ ") : (r.required ? "❌" : "· ");
    const size = r.present ? `(${r.size} bytes)` : "(missing)";
    console.log(`  ${mark} [${r.kind.padEnd(8)}] ${r.name.padEnd(28)} ${r.path}  ${size}`);
  }
  const missing = results.filter((r) => r.required && !r.present);
  if (missing.length > 0) {
    console.log(`\n❌ ${missing.length} required item(s) missing`);
    process.exit(1);
  } else {
    console.log(`\n✅ All required items present. Ready to run.`);
  }
}

function printTools() {
  const skillPath = path.join(ROOT, ".claude/skills/beer-lens.md");
  if (existsSync(skillPath)) {
    const txt = readFileSync(skillPath, "utf8");
    const commands = [...txt.matchAll(/python3 \.beer-data\/harness\.py\s+(\S+)/g)].map((m) => m[1]);
    const scripts = [...txt.matchAll(/npm run (\S+)/g)].map((m) => m[1]);
    console.log(`Tools exposed to the agent:\n`);
    console.log(`  Harness commands (${commands.length}):`);
    for (const c of [...new Set(commands)]) console.log(`    - harness.py ${c}`);
    console.log(`\n  npm scripts (${scripts.length}):`);
    for (const s of [...new Set(scripts)]) console.log(`    - npm run ${s}`);
    console.log(`\n  WebSearch: enabled (200/session budget)`);
  } else {
    console.error("❌ beer-lens.md skill not found");
    process.exit(1);
  }
}

// ── Mode dispatch ───────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: "interactive",
    query: null,
    port: "8888",
    crawlerRound: null,
    crawlerLimit: 30,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query" || a === "-q") { args.mode = "oneshot"; args.query = argv[++i] || ""; }
    else if (a === "--check") args.mode = "check";
    else if (a === "--tools") args.mode = "tools";
    else if (a === "--crawler") {
      args.mode = "shortcut-crawler";
      // optional: --round N --limit M
    }
    else if (a === "--inspector") args.mode = "shortcut-inspector";
    else if (a === "--hub") args.mode = "shortcut-hub";
    else if (a === "--port" || a === "-p") args.port = argv[++i];
    else if (a === "--round" || a === "-r") args.crawlerRound = argv[++i];
    else if (a === "--limit" || a === "-l") args.crawlerLimit = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else positional.push(a);
  }
  if (positional.length > 0 && args.mode === "interactive") {
    args.mode = "oneshot";
    args.query = positional.join(" ");
  }
  return args;
}

function printHelp() {
  console.log(`agent.mjs — Single entry point for the beer-lens Agent.

Modes:
  (default)              Launch Claude Code interactively in CWD.
                         The beer-lens.md skill auto-loads; harness.py,
                         scripts/, and WebSearch are tools.

  --query "<text>"       One-shot non-interactive query (claude -p).
  "<text>" (positional)  Same as --query.

Info:
  --check                Show bundled surface + verify required paths.
  --tools                List tools (harness commands + npm scripts).

Shortcuts (run a bundled script directly):
  --crawler [--round N] [--limit M]   Run always-on crawler round.
  --inspector                         Run skill-inspector.
  --hub [--port 8888]                 Start Skill Hub dashboard.

Examples:
  node scripts/agent.mjs                          # interactive Claude Code
  node scripts/agent.mjs "Sleep 这酒怎么样"        # one-shot query
  node scripts/agent.mjs --crawler --round 1     # run round 1
  node scripts/agent.mjs --inspector              # audit the harness
  node scripts/agent.mjs --hub                    # start dashboard on :8888
`);
}

// ── Subprocess runners ──────────────────────────────────────────

function runScript(scriptRel, scriptArgs, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(ROOT, scriptRel), ...scriptArgs], {
      cwd: ROOT,
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(0);
      else reject(new Error(`${label} exit ${code}`));
    });
    proc.on("error", reject);
  });
}

function runClaude(args, mode) {
  // mode: "interactive" or "oneshot"
  const claudeArgs = mode === "oneshot" ? ["-p", args.query] : [];
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", claudeArgs, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: "max" },
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(0);
      else reject(new Error(`claude exit ${code}`));
    });
    proc.on("error", reject);
  });
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Always sanity-check required bundle items first
  const results = checkBundle();
  const missing = results.filter((r) => r.required && !r.present);
  if (missing.length > 0) {
    console.error(`❌ Missing required items: ${missing.map((m) => m.path).join(", ")}`);
    process.exit(1);
  }

  switch (args.mode) {
    case "check":
      printCheck();
      return;
    case "tools":
      printTools();
      return;
    case "shortcut-crawler": {
      const sargs = ["--limit", String(args.crawlerLimit)];
      if (args.crawlerRound) sargs.unshift("--round", args.crawlerRound);
      console.log(`🍺 Crawler round=${args.crawlerRound ?? "n/a"} limit=${args.crawlerLimit}`);
      await runScript("scripts/always-on-crawler.mjs", sargs, "crawler");
      return;
    }
    case "shortcut-inspector":
      console.log(`🔬 Running inspector`);
      await runScript("scripts/skill-inspector.mjs", [], "inspector");
      return;
    case "shortcut-hub":
      console.log(`🛰️  Starting Skill Hub on :${args.port}`);
      await runScript("scripts/skill-hub-server.mjs", ["--port", args.port], "hub");
      return;
    case "oneshot":
      console.log(`🤖 one-shot query: "${args.query}"`);
      await runClaude(args, "oneshot");
      return;
    case "interactive":
    default:
      console.log(`🤖 launching interactive Claude Code with beer-lens skill loaded`);
      console.log(`   CWD: ${ROOT}`);
      console.log(`   Skill: .claude/skills/beer-lens.md (v6.0)`);
      console.log(`   Type your beer question or trigger (\"跑一轮 warm-list\")`);
      await runClaude(args, "interactive");
      return;
  }
}

main().catch((err) => {
  console.error(`\n❌ agent failed: ${err.message}`);
  process.exit(1);
});