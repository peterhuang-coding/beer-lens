#!/usr/bin/env node
/**
 * E2E Image Benchmark Runner
 *
 * Runs the vision pipeline (classify → OCR → quality → recommend) against
 * a set of QA test cases defined in tests/e2e/image-qa.json.
 *
 * Does NOT require a running Next.js server — calls OpenRouter directly.
 * Reuses core pipeline functions from lib/beer-agent/multi-stage-pipeline.ts
 * via the same OpenRouter client.
 *
 * Usage:
 *   npm run benchmark:images
 *   npm run benchmark:images -- --case menu_clear_01    # run single case
 *   npm run benchmark:images -- --no-cache               # skip cache
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

// Load .env
loadEnv(path.join(root, ".env.local"));
loadEnv(path.join(root, ".env"));

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("❌ Missing OPENROUTER_API_KEY in .env.local");
  process.exit(1);
}

const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash";
const ANALYSIS_MODEL = process.env.OPENROUTER_ANALYSIS_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions";
const QA_PATH = path.join(root, "tests", "e2e", "image-qa.json");
const FIXTURES_DIR = path.join(root, "tests", "fixtures");
const RESULTS_DIR = path.join(root, "tests", "e2e", "results");
const CACHE_DIR = path.join(root, "tests", "e2e", ".cache");

// ── CLI args ──
const args = process.argv.slice(2);
const singleCase = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
const noCache = args.includes("--no-cache");

// ── Load QA cases ──
let qaCases;
try {
  qaCases = JSON.parse(readFileSync(QA_PATH, "utf8"));
} catch {
  console.error("❌ Failed to load QA cases from", QA_PATH);
  process.exit(1);
}

const cases = singleCase
  ? qaCases.filter(c => c.id === singleCase && c.enabled !== false)
  : qaCases.filter(c => c.enabled !== false);

if (cases.length === 0) {
  console.error(`❌ No enabled QA cases found${singleCase ? ` for id="${singleCase}"` : ""}`);
  process.exit(1);
}

console.log(`\n🧪 Beer Lens Image Benchmark\n`);
console.log(`   Vision:  ${VISION_MODEL}`);
console.log(`   Analysis: ${ANALYSIS_MODEL}`);
console.log(`   Cases:   ${cases.length}\n`);

// ── Results ──
const results = [];
let passed = 0;
let failed = 0;
const startTime = Date.now();

for (const qa of cases) {
  const caseStart = Date.now();
  const imagePath = path.join(FIXTURES_DIR, qa.image);

  if (!existsSync(imagePath)) {
    console.log(`⏭️  [${qa.id}] Image not found: ${qa.image} — skipping`);
    results.push({
      id: qa.id,
      status: "skipped",
      reason: `image_not_found: ${qa.image}`,
      durationMs: 0,
    });
    continue;
  }

  process.stdout.write(`🔍 [${qa.id}] ${qa.description}... `);

  try {
    const imageDataUrl = await readImageAsDataUrl(imagePath);
    const userText = qa.text ?? "帮我看这张图";

    // Check cache
    const cacheKey = `${qa.id}_${Buffer.from(userText).toString("base64").slice(0, 32)}`;
    let cached;
    if (!noCache) {
      cached = await readCache(cacheKey);
    }

    let pipelineResult;
    if (cached) {
      pipelineResult = cached;
      process.stdout.write("(cached) ");
    } else {
      pipelineResult = await runVisionPipeline(apiKey, imageDataUrl, userText);
      if (!noCache) await writeCache(cacheKey, pipelineResult);
    }

    // Run assertions
    const assertions = runAssertions(qa, pipelineResult);
    const allPassed = assertions.every(a => a.pass);

    const durationMs = Date.now() - caseStart;

    if (allPassed) {
      console.log(`✅ ${assertions.length}/${assertions.length} passed (${durationMs}ms)`);
      passed++;
    } else {
      const failedCount = assertions.filter(a => !a.pass).length;
      console.log(`❌ ${failedCount}/${assertions.length} failed (${durationMs}ms)`);
      for (const a of assertions.filter(a => !a.pass)) {
        console.log(`   └─ ${a.name}: expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`);
      }
      failed++;
    }

    results.push({
      id: qa.id,
      status: allPassed ? "pass" : "fail",
      durationMs,
      assertions,
      summary: {
        imageType: pipelineResult.imageContext?.imageType,
        candidateCount: pipelineResult.extracted?.items?.length ?? 0,
        ocrConfidence: pipelineResult.extracted?.items?.[0]?.confidence,
        replyPreview: pipelineResult.recommendation?.reply?.slice(0, 100),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`💥 error: ${msg.slice(0, 100)}`);
    failed++;
    results.push({
      id: qa.id,
      status: "error",
      error: msg,
      durationMs: Date.now() - caseStart,
    });
  }
}

// ── Summary ──
const totalMs = Date.now() - startTime;
const total = passed + failed;

console.log(`\n${"─".repeat(60)}`);
console.log(`\n📊 Results: ${passed}/${total} passed (${totalMs}ms)`);

if (failed > 0) {
  console.log(`\n❌ Failed cases:`);
  for (const r of results.filter(r => r.status === "fail")) {
    console.log(`   [${r.id}] ${r.assertions?.filter(a => !a.pass).map(a => a.name).join(", ")}`);
  }
}

// Save results
await mkdir(RESULTS_DIR, { recursive: true });
const resultPath = path.join(RESULTS_DIR, `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(resultPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  visionModel: VISION_MODEL,
  analysisModel: ANALYSIS_MODEL,
  totalMs,
  passed,
  failed,
  total,
  results,
}, null, 2) + "\n");
console.log(`\n📁 Results saved: ${resultPath}`);

process.exit(failed > 0 ? 1 : 0);

// ═══════════════════════════════════════════════════════════
// Vision Pipeline (mirrors multi-stage-pipeline.ts)
// ═══════════════════════════════════════════════════════════

async function runVisionPipeline(apiKey, imageDataUrl, userText) {
  // Stage 1: Image classification
  const imageContext = await callOpenRouterJson(apiKey, VISION_MODEL, [
    {
      role: "user",
      content: [
        { type: "text", text: `判断这张图是什么类型。只返回 JSON。
类型：menu(酒单) / tap_list(酒头列表) / bottle(瓶) / can(罐) / glass(杯中酒) / venue(环境) / unknown
还要返回 confidence、reason、needsOcr、needsLabelRecognition、canAssessVisualQuality、visibleClues。
用户补充：${userText}` },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], imageContextSchema(), "image_context", 1500);

  // Stage 2: OCR + extraction
  const extracted = await callOpenRouterJson(apiKey, VISION_MODEL, [
    {
      role: "user",
      content: [
        { type: "text", text: `从图中提取所有啤酒信息。
图片类型：${JSON.stringify(imageContext)}
- menu/tap_list: 提取所有啤酒候选项（酒名、酒厂、风格、ABV、价格）
- bottle/can: 提取单款酒标信息
- glass: 描述酒液，不要编造酒名
不确定就降低 confidence。
用户补充：${userText}` },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], beerSignalExtractSchema(), "beer_signal", 8000);

  // Stage 3: Visual quality
  const visualQuality = await callOpenRouterJson(apiKey, VISION_MODEL, [
    {
      role: "user",
      content: [
        { type: "text", text: `判断视觉质量风险（氧化、新鲜度、光照）。只能说是"疑似风险"。
图片类型：${JSON.stringify(imageContext)}
候选酒：${JSON.stringify(extracted)}
用户补充：${userText}` },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], visualQualitySchema(), "visual_quality", 3000);

  // Stage 4: Recommendation
  const beerList = (extracted.items ?? []).map((item, i) =>
    `#${item.menuIndex || i + 1} ${item.beerName} | ${item.brewery || "?"} | ${item.style || "?"} | ${item.abv}%`
  ).join("\n");

  const recommendation = await callOpenRouterJson(apiKey, ANALYSIS_MODEL, [
    {
      role: "user",
      content: `酒单:\n${beerList}\n\n图片类型: ${JSON.stringify(imageContext)}\n风险: ${JSON.stringify(visualQuality?.visualRiskFlags ?? [])}\n用户需求: ${userText}\n\n请选出 top/safe/explore/avoid 推荐。`,
    },
  ], recommendationSchema(), "recommendation", 5000);

  return { imageContext, extracted, visualQuality, recommendation };
}

// ═══════════════════════════════════════════════════════════
// Assertions
// ═══════════════════════════════════════════════════════════

function runAssertions(qa, result) {
  const assertions = [];
  const e = qa.expect;
  const { imageContext, extracted, visualQuality, recommendation } = result;

  // imageType
  if (e.imageType) {
    assertions.push({
      name: "imageType",
      pass: imageContext?.imageType === e.imageType,
      expected: e.imageType,
      actual: imageContext?.imageType,
    });
  }

  // Candidate count range
  const itemCount = extracted?.items?.length ?? 0;
  if (e.minCandidates !== undefined) {
    assertions.push({
      name: "minCandidates",
      pass: itemCount >= e.minCandidates,
      expected: `>= ${e.minCandidates}`,
      actual: itemCount,
    });
  }
  if (e.maxCandidates !== undefined) {
    assertions.push({
      name: "maxCandidates",
      pass: itemCount <= e.maxCandidates,
      expected: `<= ${e.maxCandidates}`,
      actual: itemCount,
    });
  }

  // hasReply
  if (e.hasReply) {
    assertions.push({
      name: "hasReply",
      pass: !!recommendation?.reply && recommendation.reply.length > 10,
      expected: "non-empty reply",
      actual: recommendation?.reply?.slice(0, 50) ?? "(empty)",
    });
  }

  // hasTopPick
  if (e.hasTopPick) {
    assertions.push({
      name: "hasTopPick",
      pass: !!recommendation?.topPickId && recommendation.topPickId.length > 0,
      expected: "non-empty topPickId",
      actual: recommendation?.topPickId ?? "(empty)",
    });
  }

  // OCR confidence
  if (e.ocrConfidenceMin !== undefined && itemCount > 0) {
    const minConf = Math.min(...extracted.items.map(i => i.confidence ?? 0));
    assertions.push({
      name: "ocrConfidenceMin",
      pass: minConf >= e.ocrConfidenceMin,
      expected: `>= ${e.ocrConfidenceMin}`,
      actual: minConf,
    });
  }

  // hasLowConfidence
  if (e.hasLowConfidence) {
    const hasLow = (extracted?.uncertainties?.length ?? 0) > 0 ||
      (itemCount > 0 && extracted.items.some(i => (i.confidence ?? 1) < 0.6)) ||
      (visualQuality?.visualRiskFlags?.includes("low_confidence"));
    assertions.push({
      name: "hasLowConfidence",
      pass: hasLow,
      expected: "low confidence indicators present",
      actual: hasLow ? "present" : "not present",
    });
  }

  // noRiskFlags
  if (e.noRiskFlags) {
    for (const flag of e.noRiskFlags) {
      const hasFlag = visualQuality?.visualRiskFlags?.includes(flag) ||
        extracted?.items?.some(i => (i.riskFlags ?? []).includes(flag));
      assertions.push({
        name: `noRiskFlag:${flag}`,
        pass: !hasFlag,
        expected: `no "${flag}"`,
        actual: hasFlag ? `has "${flag}"` : "none",
      });
    }
  }

  // hasBrewery
  if (e.hasBrewery && itemCount > 0) {
    const hasBrewery = extracted.items.some(i => i.brewery && i.brewery.length > 0);
    assertions.push({
      name: "hasBrewery",
      pass: hasBrewery,
      expected: "brewery name present",
      actual: hasBrewery ? extracted.items.find(i => i.brewery)?.brewery : "(none)",
    });
  }

  // hasStyle
  if (e.hasStyle && itemCount > 0) {
    const hasStyle = extracted.items.some(i => i.style && i.style.length > 0);
    assertions.push({
      name: "hasStyle",
      pass: hasStyle,
      expected: "style present",
      actual: hasStyle ? extracted.items.find(i => i.style)?.style : "(none)",
    });
  }

  // shouldNotInventName (for glass photos)
  if (e.shouldNotInventName) {
    const hasInventedName = itemCount > 0 && extracted.items.some(i =>
      (i.confidence ?? 0) > 0.5 && i.beerName && i.beerName.length > 2
    );
    const hasCaveat = (visualQuality?.caveat ?? "").length > 0 ||
      (extracted?.uncertainties ?? []).length > 0;
    assertions.push({
      name: "shouldNotInventName",
      pass: !hasInventedName || hasCaveat,
      expected: "no high-confidence beer name invented",
      actual: hasInventedName && !hasCaveat
        ? `invented: ${extracted.items[0]?.beerName}`
        : "ok",
    });
  }

  // intentShouldBe — we check via the imageType heuristic (menu → recommend, bottle → label_check)
  if (e.intentShouldBe) {
    const type = imageContext?.imageType;
    let inferredIntent = "unclear";
    if (type === "menu" || type === "tap_list") inferredIntent = "menu_recommend";
    else if (type === "bottle" || type === "can") inferredIntent = "label_check";
    else if (type === "glass") inferredIntent = "menu_recommend";

    assertions.push({
      name: "intentShouldBe",
      pass: inferredIntent === e.intentShouldBe,
      expected: e.intentShouldBe,
      actual: inferredIntent,
    });
  }

  return assertions;
}

// ═══════════════════════════════════════════════════════════
// OpenRouter API
// ═══════════════════════════════════════════════════════════

async function callOpenRouterJson(apiKey, model, messages, schema, schemaName, maxTokens) {
  // Use json_object mode (more reliable than strict json_schema for vision models)
  const body = {
    model,
    messages: messages.map(m => ({
      ...m,
      content: Array.isArray(m.content)
        ? m.content.map(p => p.type === "text"
          ? { ...p, text: p.text + `\n\nYou MUST return ONLY a single JSON object matching this schema exactly:\n${JSON.stringify(schema)}` }
          : p)
        : m.content + `\n\nYou MUST return ONLY a single JSON object matching this schema exactly:\n${JSON.stringify(schema)}`,
    })),
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };

  let content;
  try {
    content = await callOpenRouter(apiKey, body);
  } catch {
    // Fallback: try without response_format constraint
    const fallbackBody = { ...body, response_format: undefined };
    content = await callOpenRouter(apiKey, fallbackBody);
  }

  return parseJson(content, schemaName);
}

async function callOpenRouter(apiKey, body) {
  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Beer Lens",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenRouter");
  return content;
}

function parseJson(content, label) {
  try { return JSON.parse(content.trim()); } catch {}
  // Try to find and fix truncated JSON by completing braces/brackets
  let json = content.trim();
  // Remove markdown fences
  json = json.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  // Try to salvage truncated JSON by balancing braces
  let depth = 0;
  let inString = false;
  let lastValidPos = json.length;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === "\\" && inString) { i++; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (depth === 0 && (ch === "}" || ch === "]")) lastValidPos = i + 1;
  }

  if (lastValidPos < json.length) {
    json = json.slice(0, lastValidPos);
    try { return JSON.parse(json); } catch {}
  }

  // Close unclosed strings and braces
  json = json.replace(/,\s*$/, ""); // trailing comma
  // Count unclosed braces
  let objDepth = 0, arrDepth = 0;
  inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === "\\" && inString) { i++; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") objDepth++;
    if (ch === "}") objDepth--;
    if (ch === "[") arrDepth++;
    if (ch === "]") arrDepth--;
  }
  // Close unclosed string
  if (inString) json += '"';
  json += "]".repeat(Math.max(0, arrDepth));
  json += "}".repeat(Math.max(0, objDepth));

  try { return JSON.parse(json); } catch (e) {
    throw new Error(`[${label}] Could not parse JSON after salvage: ${e.message}. Content: ${content.slice(0, 200)}...`);
  }
}

// ═══════════════════════════════════════════════════════════
// Cache
// ═══════════════════════════════════════════════════════════

async function readCache(key) {
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  try {
    const raw = readFileSync(cachePath, "utf8");
    const data = JSON.parse(raw);
    // Cache valid for 1 hour
    if (Date.now() - data.timestamp < 3600000) return data.result;
  } catch {}
  return null;
}

async function writeCache(key, result) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  await writeFile(cachePath, JSON.stringify({ timestamp: Date.now(), result }, null, 2));
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

async function readImageAsDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
  const mime = mimeMap[ext] ?? "image/jpeg";
  const buffer = await readFile(filePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

// ── JSON Schemas (same as multi-stage-pipeline.ts) ──

function imageContextSchema() {
  return {
    type: "object",
    required: ["imageType", "confidence", "reason", "needsOcr", "needsLabelRecognition", "canAssessVisualQuality", "visibleClues"],
    properties: {
      imageType: { type: "string", enum: ["menu", "tap_list", "bottle", "can", "glass", "venue", "unknown"] },
      confidence: { type: "number" },
      reason: { type: "string" },
      needsOcr: { type: "boolean" },
      needsLabelRecognition: { type: "boolean" },
      canAssessVisualQuality: { type: "boolean" },
      visibleClues: { type: "array", items: { type: "string" } },
    },
  };
}

function beerSignalExtractSchema() {
  return {
    type: "object",
    required: ["sourceType", "rawText", "items", "visualBeerDescription", "uncertainties"],
    properties: {
      sourceType: { type: "string", enum: ["menu", "tap_list", "bottle", "can", "glass", "venue", "text", "unknown"] },
      rawText: { type: "string" },
      visualBeerDescription: {
        type: "object",
        required: ["color", "clarity", "foam", "visiblePackagingDate", "notes"],
        properties: {
          color: { type: "string" }, clarity: { type: "string" }, foam: { type: "string" },
          visiblePackagingDate: { type: "string" }, notes: { type: "array", items: { type: "string" } },
        },
      },
      uncertainties: { type: "array", items: { type: "string" } },
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["menuIndex", "rawText", "beerName", "brewery", "style", "abv", "ibu", "price", "serving", "packagingDate", "confidence"],
          properties: {
            menuIndex: { type: "integer" }, rawText: { type: "string" }, beerName: { type: "string" },
            brewery: { type: "string" }, style: { type: "string" }, abv: { type: "number" },
            ibu: { type: "number" }, price: { type: "number" }, serving: { type: "string" },
            packagingDate: { type: "string" }, confidence: { type: "number" },
          },
        },
      },
    },
  };
}

function visualQualitySchema() {
  return {
    type: "object",
    required: ["canAssess", "visualRiskFlags", "oxidationRisk", "freshnessRisk", "lightstrikeRisk", "evidence", "caveat"],
    properties: {
      canAssess: { type: "boolean" },
      visualRiskFlags: {
        type: "array",
        items: { type: "string", enum: ["possible_oxidation", "possible_stale_hops", "possible_lightstrike", "low_foam", "unexpected_haze", "unexpected_darkening", "date_not_visible", "packaging_damage", "low_confidence"] },
      },
      oxidationRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      freshnessRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      lightstrikeRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      evidence: { type: "array", items: { type: "string" } },
      caveat: { type: "string" },
    },
  };
}

function recommendationSchema() {
  return {
    type: "object",
    required: ["reply", "topPickId", "safePickId", "explorePickId", "avoidPickId", "topReason", "safeReason", "exploreReason", "avoidReason"],
    properties: {
      reply: { type: "string" },
      topPickId: { type: "string" }, safePickId: { type: "string" },
      explorePickId: { type: "string" }, avoidPickId: { type: "string" },
      topReason: { type: "string" }, safeReason: { type: "string" },
      exploreReason: { type: "string" }, avoidReason: { type: "string" },
    },
  };
}
