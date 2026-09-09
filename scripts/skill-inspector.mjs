#!/usr/bin/env node
/** Measured project state; never infer test success from source code. */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  readJson,
  getStats,
  getHealth,
  getCrawlLog,
} from "./project-data.mjs";
async function inspect() {
  const issues = [];
  const health = await getHealth();
  const stats = health.healthy ? await getStats() : null;
  if (!health.healthy)
    issues.push({
      severity: "error",
      kind: "data_unavailable",
      message: health.error ?? "No seed records",
    });
  const manifest = await readJson("data/skill-manifest.json");
  const builtin = manifest.skills ?? [];
  for (const skill of builtin) {
    try {
      await access(path.join(ROOT, skill.handlerFile));
    } catch {
      issues.push({ severity: "error", kind: "missing_skill", id: skill.id });
    }
  }
  const projectSkill = ".claude/skills/beer-lens/SKILL.md";
  try {
    await access(path.join(ROOT, projectSkill));
  } catch {
    issues.push({ severity: "error", kind: "missing_project_skill" });
  }
  const missing = await readJson("data/warm-list-gaps.json", []);
  if (missing.length)
    issues.push({
      severity: "warn",
      kind: "warm_list_gap",
      count: missing.length,
    });
  if (stats?.missing_abv || stats?.missing_rating)
    issues.push({
      severity: "warn",
      kind: "seed_fields_missing",
      abv: stats.missing_abv,
      rating: stats.missing_rating,
    });
  const recent = await getCrawlLog();
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      verdict: issues.some((i) => i.severity === "error")
        ? "BROKEN"
        : issues.length
          ? "DEGRADED"
          : "OK",
      issues: issues.length,
    },
    phases: {
      state: { stats, health },
      gaps: {
        missing,
        issues,
        sources_present: stats ? [stats.source] : [],
        sources_unchecked: ["external services", "optional SQLite cache"],
      },
      skills: {
        builtin_count: builtin.length,
        builtin_ids: builtin.map((s) => s.id),
        project_skills: [projectSkill],
      },
      regression: {
        status: "not_run",
        passed: null,
        total: null,
        command: "npm test",
        recent_operations: recent.slice(-5),
      },
      proposals: {
        cases: missing.map((t) => ({ kind: "warm_list_gap", target: t })),
        actions: issues.map((i) => ({
          kind: i.kind,
          priority: i.severity === "error" ? "P0" : "P2",
        })),
      },
    },
  };
}
async function main() {
  const argv = process.argv.slice(2);
  let print = false,
    output = "data/inspector-report.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: npm run inspector -- [--print] [--output PATH]\nReports portable project state. Regression status remains not_run; execute npm test separately.",
      );
      return;
    }
    if (argv[i] === "--print" || argv[i] === "-p") print = true;
    else if (argv[i] === "--output" || argv[i] === "-o") {
      output = argv[++i];
      if (!output || output.startsWith("-"))
        throw new Error("Missing output path");
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const report = await inspect();
  if (print) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    const file = path.resolve(output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
    console.log(`Wrote ${file}: ${report.summary.verdict}`);
  }
  if (report.summary.verdict === "BROKEN") process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
