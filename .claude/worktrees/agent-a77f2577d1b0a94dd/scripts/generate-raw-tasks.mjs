#!/usr/bin/env node
/**
 * generate-raw-tasks.mjs — Convert raw crawl data into raw labeling tasks.
 *
 * Usage:
 *   node scripts/generate-raw-tasks.mjs
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();

// ── Pure helpers (self-contained for standalone script) ──

function normalizeUrl(url) {
  try {
    const u = new URL(url.trim());
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

function hashKey(...parts) {
  const input = parts.map((p) => normalizeUrl(p)).join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function rawTaskId(item) {
  return `raw_${hashKey(item.sourceUrl, item.imageUrl)}`;
}

function buildTaskQuestions() {
  return [
    { id: "is_beer_label", type: "yesno", prompt: "这张图是否包含啤酒瓶/罐/酒标？" },
    { id: "beer_name", type: "text", prompt: "图中最可能的啤酒名称是什么？" },
    { id: "brand", type: "text", prompt: "图中品牌是什么？" },
    { id: "style", type: "select", prompt: "能否识别风格？", options: ["IPA", "Stout", "Lager", "Sour", "Pilsner", "Porter", "Wheat", "Saison", "其他", "无法判断"] },
    { id: "abv", type: "text", prompt: "能否识别 ABV？" },
    { id: "visible_text", type: "text", prompt: "OCR/肉眼能看到哪些关键文字？" },
    { id: "image_quality", type: "select", prompt: "图片质量是否适合做识别测试？", options: ["清晰可用", "勉强可读", "模糊不清", "完全不适用"] },
  ];
}

function crawlItemToRawTask(item) {
  const now = new Date().toISOString();
  return {
    id: rawTaskId(item),
    source: item.sourceName,
    sourceUrl: item.sourceUrl,
    imageUrl: item.imageUrl,
    title: item.pageTitle,
    candidateBeerName: item.candidateBeerName,
    description: item.pageDescription,
    questions: buildTaskQuestions(),
    labels: {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function isTaskDuplicate(existingTasks, newTask) {
  return existingTasks.some(
    (t) =>
      t.id === newTask.id ||
      (normalizeUrl(t.sourceUrl) === normalizeUrl(newTask.sourceUrl) &&
        normalizeUrl(t.imageUrl) === normalizeUrl(newTask.imageUrl)),
  );
}

// ── Main ──

async function main() {
  console.log("🍺 Generating 标注任务...\n");

  // Read all raw crawl files
  const rawDir = path.resolve(ROOT, "data", "raw-crawl", "raw");
  let rawFiles;
  try {
    rawFiles = await readdir(rawDir);
  } catch {
    console.log("⚠️  No raw crawl data found. Run 'npm run raw:crawl' first.");
    process.exit(0);
  }

  const jsonFiles = rawFiles.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    console.log("⚠️  No raw JSON files found in data/raw-crawl/raw/");
    process.exit(0);
  }

  console.log(`📂 Found ${jsonFiles.length} crawl files:\n`);
  const allCrawlItems = [];
  for (const file of jsonFiles) {
    const filePath = path.join(rawDir, file);
    try {
      const data = JSON.parse(await readFile(filePath, "utf8"));
      const items = data.items || [];
      console.log(`   ${file}: ${items.length} items`);
      allCrawlItems.push(...items);
    } catch {
      console.log(`   ${file}: ❌ parse error, skipping`);
    }
  }

  // Read existing tasks
  const tasksPath = path.resolve(ROOT, "data", "raw-data", "tasks.json");
  let existingTasks = [];
  if (existsSync(tasksPath)) {
    try {
      existingTasks = JSON.parse(await readFile(tasksPath, "utf8"));
      if (!Array.isArray(existingTasks)) existingTasks = [];
    } catch {
      console.log("⚠️  Existing tasks.json is corrupt, starting fresh.");
    }
  }

  console.log(`\n📋 ${existingTasks.length} existing tasks`);

  // Generate new tasks (skip duplicates)
  let addedCount = 0;
  for (const item of allCrawlItems) {
    const task = crawlItemToRawTask(item);
    if (!isTaskDuplicate(existingTasks, task)) {
      existingTasks.push(task);
      addedCount++;
    }
  }

  // Write back
  const tasksDir = path.dirname(tasksPath);
  await mkdir(tasksDir, { recursive: true });
  await writeFile(tasksPath, JSON.stringify(existingTasks, null, 2) + "\n");

  console.log(`\n✅ Added ${addedCount} new tasks`);
  console.log(`📦 Total tasks: ${existingTasks.length}`);
  console.log(`   Pending: ${existingTasks.filter((t) => t.status === "pending").length}`);
  console.log(`   Labeled: ${existingTasks.filter((t) => t.status === "labeled").length}`);
  console.log(`   Skipped: ${existingTasks.filter((t) => t.status === "skipped").length}`);
  console.log(`   Exported: ${existingTasks.filter((t) => t.status === "exported").length}`);
  console.log(`\nNext: open the debug page → 标注 tab to label tasks.`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
