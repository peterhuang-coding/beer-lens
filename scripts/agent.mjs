#!/usr/bin/env node
/** One entry point for Claude Code and portable project tools. */
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, getApis } from "./project-data.mjs";
const SKILL = ".claude/skills/beer-lens/SKILL.md";
function parseArgs(argv) {
  const args = {
    mode: null,
    query: null,
    port: "8888",
    round: null,
    limit: "30",
  };
  const positional = [];
  function mode(value) {
    if (args.mode && args.mode !== value)
      throw new Error("Choose only one mode");
    args.mode = value;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      mode("help");
    } else if (
      ["--check", "--tools", "--crawler", "--inspector", "--hub"].includes(a)
    )
      mode(a.slice(2));
    else if (
      [
        "--query",
        "-q",
        "--port",
        "-p",
        "--round",
        "-r",
        "--limit",
        "-l",
      ].includes(a)
    ) {
      const key = {
        "--query": "query",
        "-q": "query",
        "--port": "port",
        "-p": "port",
        "--round": "round",
        "-r": "round",
        "--limit": "limit",
        "-l": "limit",
      }[a];
      const value = argv[++i];
      if (!value || value.startsWith("-"))
        throw new Error(`Missing value for ${a}`);
      args[key] = value;
      if (key === "query") mode("oneshot");
    } else if (a.startsWith("-")) throw new Error(`Unknown argument: ${a}`);
    else positional.push(a);
  }
  if (positional.length) {
    mode("oneshot");
    if (args.query) throw new Error("Use either --query or positional text");
    args.query = positional.join(" ");
  }
  args.mode ??= "interactive";
  return args;
}
async function checkBundle() {
  const files = [
    SKILL,
    "data/chinese-craft-beers.json",
    "data/skill-manifest.json",
    "scripts/project-data.mjs",
    "scripts/always-on-crawler.mjs",
    "scripts/skill-inspector.mjs",
    "scripts/skill-hub-server.mjs",
  ];
  for (const f of files) {
    await access(path.join(ROOT, f));
  }
  console.log(
    "All required items present. Claude Code is required only for conversational modes.",
  );
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    proc.once("error", (error) =>
      reject(
        new Error(
          error.code === "ENOENT"
            ? `${command} is not installed or is not on PATH`
            : error.message,
        ),
      ),
    );
    proc.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${signal ?? code}`)),
    );
  });
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(
      "Usage: npm run agent -- [--query TEXT | TEXT | --check | --tools | --crawler | --inspector | --hub]\nDefault: interactive Claude Code with the project skill.\n--crawler [--round N] [--limit N] generates targets, not network requests.\n--hub [--port 8888] opens a local read-only dashboard.",
    );
    return;
  }
  if (args.mode === "check") return checkBundle();
  if (args.mode === "tools") {
    console.log(JSON.stringify(await getApis(), null, 2));
    return;
  }
  if (args.mode === "crawler")
    return run(process.execPath, [
      path.join(ROOT, "scripts/always-on-crawler.mjs"),
      "--limit",
      args.limit,
      ...(args.round ? ["--round", args.round] : []),
    ]);
  if (args.mode === "inspector")
    return run(process.execPath, [
      path.join(ROOT, "scripts/skill-inspector.mjs"),
    ]);
  if (args.mode === "hub")
    return run(process.execPath, [
      path.join(ROOT, "scripts/skill-hub-server.mjs"),
      "--port",
      args.port,
    ]);
  const skill = await readFile(path.join(ROOT, SKILL), "utf8");
  await run("claude", [
    ...(args.mode === "oneshot" ? ["-p", args.query] : []),
    "--append-system-prompt",
    skill,
  ]);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
