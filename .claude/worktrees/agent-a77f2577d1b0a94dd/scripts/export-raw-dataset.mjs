#!/usr/bin/env node
/**
 * export-raw-dataset.mjs — Export labeled 标注 tasks as JSONL dataset.
 *
 * Usage:
 *   node scripts/export-raw-dataset.mjs
 *   node scripts/export-raw-dataset.mjs --regression-cases
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// ── Args ──

function parseArgs(argv) {
  const args = { regressionCases: false };
  for (const a of argv) {
    if (a === "--regression-cases") args.regressionCases = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`原始数据导出脚本

Usage:
  node scripts/export-raw-dataset.mjs [options]

Options:
  --regression-cases   Also generate data/regression-cases.raw-generated.json
  --help, -h           Show this help
`);
}

// ── Main ──

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("🍺 Exporting VQA dataset...\n");

  // Read tasks
  const tasksPath = path.resolve(ROOT, "data", "raw-data", "tasks.json");
  let tasks = [];
  try {
    tasks = JSON.parse(await readFile(tasksPath, "utf8"));
    if (!Array.isArray(tasks)) tasks = [];
  } catch {
    console.log("⚠️  No tasks.json found. Nothing to export.");
    process.exit(0);
  }

  // Filter labeled
  const labeled = tasks.filter((t) => t.status === "labeled");

  if (labeled.length === 0) {
    console.log("⚠️  No labeled tasks. Label some tasks first in the VQA tab.");
    process.exit(0);
  }

  // Write JSONL
  const datasetDir = path.resolve(ROOT, "data", "raw-dataset");
  await mkdir(datasetDir, { recursive: true });

  const jsonlPath = path.join(datasetDir, "labeled.jsonl");
  const jsonlContent = labeled
    .map((t) => JSON.stringify(t))
    .join("\n") + "\n";

  await writeFile(jsonlPath, jsonlContent);
  console.log(`📦 Exported ${labeled.length} labeled tasks to data/raw-dataset/labeled.jsonl`);

  // Optionally write regression cases
  if (args.regressionCases) {
    const regressionCases = labeled.map((t) => ({
      id: t.id,
      source: "raw-generated",
      imageUrl: t.imageUrl,
      sourceUrl: t.sourceUrl,
      expected: {
        isBeerLabel: t.labels.isBeerLabel,
        beerName: t.labels.beerName || undefined,
        brand: t.labels.brand || undefined,
        style: t.labels.style || undefined,
        abv: t.labels.abv || undefined,
        visibleText: t.labels.visibleText || undefined,
      },
      imageQuality: t.labels.imageQuality || undefined,
      confidence: t.labels.confidence || undefined,
      notes: t.labels.notes || undefined,
      labeledAt: t.updatedAt,
    }));

    const regressionsPath = path.resolve(ROOT, "data", "regression-cases.vqa.generated.json");
    // Don't overwrite existing regression-cases.json if it exists (separate file anyway)
    await writeFile(regressionsPath, JSON.stringify(regressionCases, null, 2) + "\n");
    console.log(`📦 Exported ${labeled.length} regression cases to data/regression-cases.vqa.generated.json`);
  }

  // Mark as exported
  for (const t of tasks) {
    if (t.status === "labeled") {
      t.status = "exported";
    }
  }
  await writeFile(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  console.log(`✅ Marked ${labeled.length} tasks as "exported"`);

  console.log(`\nStats:`);
  console.log(`   Total tasks:  ${tasks.length}`);
  console.log(`   Labeled:      ${labeled.length} (now exported)`);
  console.log(`   Remaining:    ${tasks.filter((t) => t.status === "pending").length} pending, ${tasks.filter((t) => t.status === "skipped").length} skipped`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
