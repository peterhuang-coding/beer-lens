#!/usr/bin/env node
/**
 * collect-queries.mjs — Collect real user queries from traces and cases data,
 * deduplicate, and generate labeling tasks for data annotation.
 *
 * Usage:
 *   node scripts/collect-queries.mjs
 *
 * Output: data/raw-data/query-tasks.json
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();

// ── Helpers ──

function hashQuery(q) {
  return createHash("sha256").update(q.trim().toLowerCase()).digest("hex").slice(0, 16);
}

function createTaskId(query) {
  return `qcol_${hashQuery(query)}`;
}

function buildQueryQuestions() {
  return [
    { id: "expected_intent", type: "select", prompt: "期望的意图是什么？",
      options: ["menu_recommend", "tasting_feedback", "profile_query", "beer_knowledge", "label_check", "memory_correction", "unclear"] },
    { id: "expected_reply", type: "text", prompt: "期望的回复（如果有印象，可以写关键信息，不用完整句子）" },
    { id: "is_goodcase", type: "yesno", prompt: "这次处理的整体效果算好还是不好？" },
    { id: "tags", type: "multi", prompt: "场景标签（可多选）",
      options: ["推荐", "品饮", "打断/追问", "知识问答", "记忆纠正", "酒标检查", "问候/闲聊"] },
    { id: "note", type: "text", prompt: "备注（可选）" },
  ];
}

function queryToTask(query, intent, source) {
  const now = new Date().toISOString();
  return {
    id: createTaskId(query),
    source: "query_collect",
    query,
    intent: intent || null,
    sourceType: source || "unknown",
    questions: buildQueryQuestions(),
    labels: {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function isDuplicate(tasks, query) {
  const id = createTaskId(query);
  return tasks.some((t) => t.id === id);
}

// ── Read sources ──

async function readCases() {
  const casesPath = path.resolve(ROOT, "data", "cases.json");
  try {
    const raw = await readFile(casesPath, "utf8");
    return JSON.parse(raw);
  } catch {
    console.log("⚠️  data/cases.json not found or unreadable, skipping.");
    return [];
  }
}

async function readTraces() {
  const tracesDir = path.resolve(ROOT, "data", "traces");
  const queries = [];
  try {
    const dateDirs = await readdir(tracesDir);
    for (const dateDir of dateDirs) {
      const dirPath = path.join(tracesDir, dateDir);
      let files;
      try {
        files = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const trace = JSON.parse(await readFile(path.join(dirPath, file), "utf8"));
          const text = trace?.input?.lastUserText;
          if (text && typeof text === "string" && text.trim().length > 0) {
            queries.push({ text: text.trim(), intent: trace?.intentResult?.intent });
          }
        } catch {
          // skip corrupt trace files
        }
      }
    }
  } catch {
    console.log("⚠️  data/traces/ directory not found.");
  }
  return queries;
}

// ── Main ──

async function main() {
  console.log("📋 Collecting real user queries...\n");

  // 1. Collect from cases
  const cases = await readCases();
  const caseQueries = cases
    .filter((c) => c?.input?.text && typeof c.input.text === "string" && c.input.text.trim().length > 0)
    .map((c) => ({ text: c.input.text.trim(), intent: c.intent?.name, source: "case" }));

  console.log(`   📂 Cases:       ${caseQueries.length} queries`);

  // 2. Collect from traces
  const traceQueries = await readTraces();
  console.log(`   📂 Traces:      ${traceQueries.length} queries`);

  // 3. Merge & dedup
  const allSource = [...caseQueries, ...traceQueries.map((q) => ({ ...q, source: "trace" }))];
  const seen = new Set();
  const uniqueQueries = [];
  for (const q of allSource) {
    const key = q.text.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueQueries.push(q);
  }
  console.log(`   🧹 After dedup: ${uniqueQueries.length} unique queries\n`);

  // 4. Load existing tasks
  const tasksDir = path.resolve(ROOT, "data", "raw-data");
  const tasksPath = path.join(tasksDir, "query-tasks.json");
  let existingTasks = [];
  if (existsSync(tasksPath)) {
    try {
      existingTasks = JSON.parse(await readFile(tasksPath, "utf8"));
      if (!Array.isArray(existingTasks)) existingTasks = [];
      console.log(`   📋 Existing tasks: ${existingTasks.length}`);
    } catch {
      console.log("   ⚠️  Existing query-tasks.json corrupt, starting fresh.");
    }
  }

  // 5. Generate new tasks (only for unseen queries)
  let newCount = 0;
  for (const q of uniqueQueries) {
    if (isDuplicate(existingTasks, q.text)) continue;
    const task = queryToTask(q.text, q.intent, q.source);
    existingTasks.push(task);
    newCount++;
  }
  console.log(`   ➕ New tasks added: ${newCount}`);
  console.log(`   📦 Total tasks:     ${existingTasks.length}\n`);

  // 6. Write
  await mkdir(tasksDir, { recursive: true });
  await writeFile(tasksPath, JSON.stringify(existingTasks, null, 2) + "\n", "utf8");
  console.log(`✅ Written to ${tasksPath}`);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});