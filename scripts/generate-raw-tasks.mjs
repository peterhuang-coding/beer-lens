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

// ── MIME sniffing for data: URLs (catches SVG-as-JPEG bug) ──
// Decodes only the prefix bytes needed for magic-byte detection.
// Backward compat: if `forceMime` is present on the input item, skip sniff.
const MIME_SNIFF_HEAD_BYTES = 64;

function decodeDataUrlPrefix(dataUrl) {
  // Returns { declared, base64 } or null if not a data: URL.
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) return null;
  const header = dataUrl.slice(5, commaIdx); // after "data:"
  const payload = dataUrl.slice(commaIdx + 1);
  // header format: [<mediatype>][;base64]
  const parts = header.split(";");
  const declared = parts[0] || "";
  const isBase64 = parts.includes("base64");
  if (!isBase64) return { declared, base64: null, payload };
  return { declared, base64: payload };
}

function sniffMimeFromBytes(buf) {
  // buf is Buffer; check first few bytes for magic signatures.
  if (!buf || buf.length === 0) return "unknown";
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // GIF: GIF87a / GIF89a
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  // SVG: starts with <svg or <?xml followed by <svg, or contains <svg within prefix
  const head = buf.toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) return "image/svg+xml";
  return "unknown";
}

function sniffMimeFromDataUrl(dataUrl) {
  // Returns { declared, sniffed, corrected, error }
  const meta = decodeDataUrlPrefix(dataUrl);
  if (!meta) return { declared: null, sniffed: null, corrected: null, error: "not_data_url" };
  const declared = meta.declared;
  if (!meta.base64) return { declared, sniffed: null, corrected: null, error: "not_base64" };
  let buf;
  try {
    buf = Buffer.from(meta.base64.slice(0, MIME_SNIFF_HEAD_BYTES * 2), "base64");
  } catch {
    return { declared, sniffed: null, corrected: null, error: "decode_failed" };
  }
  const sniffed = sniffMimeFromBytes(buf);
  let corrected = null;
  if (sniffed !== "unknown" && declared && declared !== sniffed) {
    corrected = sniffed;
  }
  return { declared, sniffed, corrected, error: null };
}

function crawlItemToRawTask(item) {
  const now = new Date().toISOString();
  const task = {
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
  // ── MIME sniff (catches SVG-as-JPEG data: URLs) ──
  // Backward compat: if forceMime is explicitly set on the item, skip detection.
  if (item.forceMime) {
    task.mimeDeclared = item.forceMime;
    task.mimeSniffed = item.forceMime;
    task.mimeSkipped = "forceMime";
  } else if (typeof item.imageUrl === "string" && item.imageUrl.startsWith("data:")) {
    const sniff = sniffMimeFromDataUrl(item.imageUrl);
    task.mimeDeclared = sniff.declared || null;
    task.mimeSniffed = sniff.sniffed;
    if (sniff.corrected) {
      task.mimeCorrected = sniff.corrected;
      task.mimeError = null;
    } else if (sniff.error) {
      task.mimeError = sniff.error;
    }
  }
  return task;
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
  let mimeCorrectedCount = 0;
  const mimeMismatchReport = [];
  for (const item of allCrawlItems) {
    const task = crawlItemToRawTask(item);
    if (!isTaskDuplicate(existingTasks, task)) {
      existingTasks.push(task);
      addedCount++;
      if (task.mimeCorrected) {
        mimeCorrectedCount++;
        mimeMismatchReport.push({
          id: task.id,
          source: task.source,
          declared: task.mimeDeclared,
          sniffed: task.mimeSniffed,
          mimeCorrected: task.mimeCorrected,
        });
      }
    }
  }

  // Write back (skip if --dry-run)
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun) {
    const tasksDir = path.dirname(tasksPath);
    await mkdir(tasksDir, { recursive: true });
    await writeFile(tasksPath, JSON.stringify(existingTasks, null, 2) + "\n");
  } else {
    console.log("\n--dry-run: not writing to disk");
  }

  console.log(`\n✅ Added ${addedCount} new tasks`);
  console.log(`📦 Total tasks: ${existingTasks.length}`);
  console.log(`   Pending: ${existingTasks.filter((t) => t.status === "pending").length}`);
  console.log(`   Labeled: ${existingTasks.filter((t) => t.status === "labeled").length}`);
  console.log(`   Skipped: ${existingTasks.filter((t) => t.status === "skipped").length}`);
  console.log(`   Exported: ${existingTasks.filter((t) => t.status === "exported").length}`);
  if (mimeMismatchReport.length > 0) {
    console.log(`\n⚠️  MIME mismatches detected: ${mimeCorrectedCount}`);
    for (const m of mimeMismatchReport.slice(0, 10)) {
      console.log(`   ${m.id} [${m.source}]: declared=${m.declared} → sniffed=${m.sniffed} (mimeCorrected=${m.mimeCorrected})`);
    }
    if (mimeMismatchReport.length > 10) {
      console.log(`   ... and ${mimeMismatchReport.length - 10} more`);
    }
  }
  console.log(`\nNext: open the debug page → 标注 tab to label tasks.`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
