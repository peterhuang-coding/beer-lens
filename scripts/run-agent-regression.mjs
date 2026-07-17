#!/usr/bin/env node
/**
 * Beer Lens Agent Regression Test Runner
 *
 * Makes real HTTP calls to POST /api/agent, evaluates responses against
 * expected behavior, writes regression reports and badcase records.
 *
 * Usage:
 *   npm run test:agent
 *   npm run test:agent -- --tag recommend
 *   npm run test:agent -- --limit 5 --timeout-ms 60000
 *   npm run test:agent -- --url http://localhost:3000/api/agent --write-badcases false
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

// ── Load .env.local (without printing sensitive values) ──
loadEnv(path.join(root, ".env.local"));
loadEnv(path.join(root, ".env"));

// ── CLI Args ──
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const BASE_URL = args.url ?? "http://localhost:3000/api/agent";
const CASES_FILE = args.cases ?? path.join(root, "data", "regression-cases.json");
const WRITE_BADCASES = args.writeBadcases !== false; // default true
const RUN_ID = Date.now().toString(36);
const CONV_PREFIX = args.conversationPrefix ?? `reg-${RUN_ID}`;
const USER_ID = args.userId ?? "regression-user";
const TIMEOUT_MS = args.timeoutMs ?? 30000;
const TAG_FILTER = args.tag ?? null;
const LIMIT = args.limit ?? null;

// ── Load regression cases ──
let allCases = [];
try {
  const raw = await readFile(CASES_FILE, "utf8");
  allCases = JSON.parse(raw);
} catch (err) {
  console.error(`Failed to load regression cases from ${CASES_FILE}: ${err.message}`);
  process.exit(1);
}

// Filter by tag / limit
let cases = allCases;
if (TAG_FILTER) {
  cases = cases.filter((c) => (c.tags ?? []).includes(TAG_FILTER));
}
if (LIMIT != null) {
  cases = cases.slice(0, Number(LIMIT));
}

if (cases.length === 0) {
  console.log("No regression cases to run (check --tag / --limit / --cases).");
  process.exit(0);
}

console.log(`\n=== Beer Lens Agent Regression ===`);
console.log(`Target:  ${BASE_URL}`);
console.log(`Cases:   ${cases.length} / ${allCases.length}`);
console.log(`Timeout: ${TIMEOUT_MS}ms`);
console.log(`Write badcases: ${WRITE_BADCASES}`);
console.log(`User ID: ${USER_ID}`);
console.log(``);

// ── Run all cases ──
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const startTime = Date.now();

const results = [];
let passCount = 0;
let failCount = 0;
let errorCount = 0;

for (let i = 0; i < cases.length; i++) {
  const testCase = cases[i];
  const convId = `${CONV_PREFIX}-${testCase.conversationId}`;
  const userId = testCase.userId || USER_ID;

  const label = `[${i + 1}/${cases.length}] ${testCase.id}: ${testCase.name}`;
  process.stdout.write(`${label} ... `);

  const caseStart = Date.now();
  let evaluation;

  try {
    const response = await callAgent({
      url: BASE_URL,
      userId,
      conversationId: convId,
      text: testCase.inputText,
      imagePath: testCase.imagePath ?? null,
      timeoutMs: TIMEOUT_MS,
    });

    evaluation = evaluate(response, testCase);
    const elapsed = Date.now() - caseStart;

    if (evaluation.passed) {
      passCount++;
      console.log(`PASS (${elapsed}ms) intent=${evaluation.actualIntent}`);
    } else {
      failCount++;
      console.log(`FAIL (${elapsed}ms) ${evaluation.failures.join("; ")}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    evaluation = {
      passed: false,
      actualIntent: "error",
      actualReply: "",
      candidateCount: 0,
      warnings: [],
      failures: [errMsg],
      checks: { error: true },
    };
    errorCount++;
    console.log(`ERROR ${errMsg}`);
  }

  results.push({
    caseId: testCase.id,
    name: testCase.name,
    inputText: testCase.inputText,
    conversationId: convId,
    passed: evaluation.passed,
    durationMs: Date.now() - caseStart,
    ...evaluation,
  });

  // Small delay between requests
  if (i < cases.length - 1) {
    await sleep(500);
  }
}

const totalDuration = Date.now() - startTime;

// ── Build report ──
const report = {
  timestamp: new Date().toISOString(),
  config: {
    baseUrl: BASE_URL,
    userId: USER_ID,
    convPrefix: CONV_PREFIX,
    timeoutMs: TIMEOUT_MS,
  },
  summary: {
    total: cases.length,
    passed: passCount,
    failed: failCount,
    errors: errorCount,
    passRate: cases.length > 0 ? (passCount / cases.length * 100).toFixed(1) + "%" : "N/A",
    durationMs: totalDuration,
  },
  results,
};

// ── Write reports ──
const reportDir = path.join(root, "data", "regression-runs");
await mkdir(reportDir, { recursive: true });

const reportPath = path.join(reportDir, `${timestamp}.json`);
const latestPath = path.join(reportDir, "latest.json");

await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
await writeFile(latestPath, JSON.stringify(report, null, 2) + "\n");

// ── Write badcases ──
if (WRITE_BADCASES) {
  const failedResults = results.filter((r) => !r.passed);
  if (failedResults.length > 0) {
    await writeBadcases(failedResults, allCases);
  }
}

// ── Console summary ──
console.log(`\n=== Regression Summary ===`);
console.log(`Total:   ${cases.length}`);
console.log(`Passed:  ${passCount} (${report.summary.passRate})`);
console.log(`Failed:  ${failCount}`);
console.log(`Errors:  ${errorCount}`);
console.log(`Time:    ${(totalDuration / 1000).toFixed(1)}s`);
console.log(`\nReports:`);
console.log(`  ${reportPath}`);
console.log(`  ${latestPath}`);

if (failCount + errorCount > 0) {
  console.log(`\nFailures:`);
  for (const r of results) {
    if (!r.passed) {
      console.log(`  ✗ ${r.caseId}: ${r.name}`);
      console.log(`    intent=${r.actualIntent} failures=[${r.failures.join(", ")}]`);
    }
  }
}

// Exit code: non-zero on failures
process.exit(failCount + errorCount > 0 ? 1 : 0);

// ═══════════════════════════════════════════════════════════
// Agent Call
// ═══════════════════════════════════════════════════════════

async function callAgent({ url, userId, conversationId, text, imagePath, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    userId,
    conversationId,
    messages: [{ role: "user", content: text }],
    channel: "web",
  };

  if (imagePath) {
    body.image = await readImageAsBase64(imagePath);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function readImageAsBase64(imagePath) {
  const absPath = path.resolve(root, imagePath);
  const ext = path.extname(absPath).toLowerCase();
  const mimeMap = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  const mime = mimeMap[ext] ?? "image/jpeg";
  const buf = await readFile(absPath);
  const b64 = buf.toString("base64");
  return {
    name: path.basename(absPath),
    type: mime,
    dataUrl: `data:${mime};base64,${b64}`,
  };
}

// ═══════════════════════════════════════════════════════════
// Evaluation
// ═══════════════════════════════════════════════════════════

function evaluate(response, testCase) {
  const failures = [];
  const checks = {};

  // Extract actual values
  const actualIntent = response.intentResult?.intent ?? "unknown";
  const actualReply = response.reply ?? "";
  const candidateCount = response.candidates?.length ?? 0;
  const warnings = response.debug?.warnings ?? [];

  // Check 1: intent match
  if (testCase.expectedIntent) {
    checks.intentMatch = actualIntent === testCase.expectedIntent;
    if (!checks.intentMatch) {
      failures.push(`intent mismatch: expected=${testCase.expectedIntent} actual=${actualIntent}`);
    }
  }

  // Check 2: expected keywords in reply
  if (testCase.expectedKeywords && testCase.expectedKeywords.length > 0) {
    const missing = testCase.expectedKeywords.filter(
      (kw) => !actualReply.toLowerCase().includes(kw.toLowerCase()),
    );
    checks.keywordsPresent = missing.length === 0;
    if (!checks.keywordsPresent) {
      failures.push(`missing keywords: [${missing.join(", ")}]`);
    }
  }

  // Check 3: forbidden keywords
  if (testCase.forbiddenKeywords && testCase.forbiddenKeywords.length > 0) {
    const found = testCase.forbiddenKeywords.filter((kw) =>
      actualReply.toLowerCase().includes(kw.toLowerCase()),
    );
    checks.forbiddenClean = found.length === 0;
    if (!checks.forbiddenClean) {
      failures.push(`forbidden keywords found: [${found.join(", ")}]`);
    }
  }

  // Check 4: minimum candidates
  if (testCase.expectedMinCandidates != null) {
    checks.candidateCount = candidateCount >= testCase.expectedMinCandidates;
    if (!checks.candidateCount) {
      failures.push(`candidates too few: expected>=${testCase.expectedMinCandidates} actual=${candidateCount}`);
    }
  }

  // Check 5: empty reply
  if (!actualReply || actualReply.trim().length === 0) {
    checks.emptyReply = false;
    failures.push("empty reply");
  } else {
    checks.emptyReply = true;
  }

  // Check 6: error response
  if (response.error) {
    checks.noError = false;
    failures.push(`API error: ${response.error}`);
  } else {
    checks.noError = true;
  }

  // Check 7: fallback detection
  const fallbackPhrases = ["抱歉，处理你的请求时出错了", "请再试一次"];
  const isFallback = fallbackPhrases.some((p) => actualReply.includes(p));
  if (isFallback) {
    checks.notFallback = false;
    failures.push("fallback/error reply detected");
  } else {
    checks.notFallback = true;
  }

  // Check 8: warnings
  checks.hasWarnings = warnings.length > 0;

  const passed = failures.length === 0;

  return {
    passed,
    actualIntent,
    actualReply: actualReply.slice(0, 500),
    candidateCount,
    warnings,
    failures,
    checks,
  };
}

// ═══════════════════════════════════════════════════════════
// Badcase Writing
// ═══════════════════════════════════════════════════════════

async function writeBadcases(failedResults, allRegressionCases) {
  const CASES_PATH = path.join(root, "data", "cases.json");

  // Read existing cases
  let existingCases = [];
  try {
    const raw = await readFile(CASES_PATH, "utf8");
    existingCases = JSON.parse(raw);
  } catch {
    // File doesn't exist or is invalid - start fresh
  }

  let newCount = 0;

  for (const result of failedResults) {
    const regCase = allRegressionCases.find((c) => c.id === result.caseId);
    if (!regCase) continue;

    // Dedup: check if this regression case already has a recent badcase
    const dedupKey = `[regression:${result.caseId}]`;
    const alreadyExists = existingCases.some(
      (c) =>
        (c.note ?? "").includes(dedupKey) &&
        Date.now() - new Date(c.createdAt).getTime() < 24 * 60 * 60 * 1000,
    );

    if (alreadyExists) {
      console.log(`  (skip badcase: already exists for ${result.caseId})`);
      continue;
    }

    // Infer label
    const label = inferLabel(result);
    // Infer root cause
    const rootCause = inferRootCause(result);

    const badcase = {
      id: `case_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      traceId: `regression_${result.caseId}_${Date.now()}`,
      conversationId: result.conversationId,
      createdAt: new Date().toISOString(),
      input: {
        text: result.inputText,
        hasImage: false,
      },
      intent: {
        name: result.actualIntent,
        confidence: 0,
      },
      replyPreview: (result.actualReply ?? "").slice(0, 300),
      candidateCount: result.candidateCount ?? 0,
      label,
      status: "unlabeled",
      warnings: result.warnings ?? [],
      rootCause,
      expected: regCase.expectedIntent ? { intent: regCase.expectedIntent } : undefined,
      note: [
        dedupKey,
        `name: ${result.name}`,
        `failures: ${result.failures.join(" | ")}`,
        `expectedIntent: ${regCase.expectedIntent ?? "none"}`,
        `actualIntent: ${result.actualIntent}`,
      ].join("\n"),
    };

    existingCases.unshift(badcase);
    newCount++;
  }

  if (newCount > 0) {
    // Keep max 500 cases
    if (existingCases.length > 500) existingCases.length = 500;
    await writeFile(CASES_PATH, JSON.stringify(existingCases, null, 2) + "\n");
    console.log(`\n  → Wrote ${newCount} badcase(s) to ${CASES_PATH}`);
  }
}

function inferLabel(result) {
  const failures = result.failures.join(" ");

  if (failures.includes("intent mismatch")) return "intent_wrong";
  if (failures.includes("candidates too few") || failures.includes("data")) return "data_missing";
  if (failures.includes("forbidden keyword")) {
    return failures.includes("hallucin") ? "hallucination" : "response_bad";
  }
  if (result.actualIntent === "menu_recommend" && result.candidateCount === 0) {
    return "recommendation_bad";
  }
  if (failures.includes("empty reply") || failures.includes("fallback")) return "response_bad";
  return "response_bad";
}

function inferRootCause(result) {
  const failures = result.failures.join(" ");

  if (failures.includes("intent mismatch")) return "intent";
  if (failures.includes("candidates too few") || failures.includes("data")) return "beer_db";
  if (failures.includes("hallucin")) return "model";
  if (failures.includes("forbidden")) return "guardrail";
  if (failures.includes("empty reply") || failures.includes("fallback") || failures.includes("error")) return "model";
  if (result.actualIntent === "unclear") return "intent";
  return "unknown";
}

// ═══════════════════════════════════════════════════════════
// CLI & Helpers
// ═══════════════════════════════════════════════════════════

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--url") parsed.url = argv[++i];
    else if (arg === "--cases") parsed.cases = argv[++i];
    else if (arg === "--limit") parsed.limit = Number(argv[++i]);
    else if (arg === "--tag") parsed.tag = argv[++i];
    else if (arg === "--write-badcases") parsed.writeBadcases = argv[++i] !== "false";
    else if (arg === "--conversation-prefix") parsed.conversationPrefix = argv[++i];
    else if (arg === "--user-id") parsed.userId = argv[++i];
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Use --help for usage.");
      process.exit(1);
    }
  }
  return parsed;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Beer Lens Agent Regression Runner

Usage:
  npm run test:agent
  npm run test:agent -- --tag recommend
  npm run test:agent -- --limit 5 --timeout-ms 60000
  npm run test:agent -- --write-badcases false
  node scripts/run-agent-regression.mjs --url http://localhost:3000/api/agent

Options:
  --url <url>                 API endpoint (default: http://localhost:3000/api/agent)
  --cases <path>              Regression cases JSON file (default: data/regression-cases.json)
  --limit <n>                 Run only first N cases
  --tag <tag>                 Run only cases matching a tag
  --write-badcases true/false Write failed cases to data/cases.json (default: true)
  --conversation-prefix <s>   Prefix for conversation IDs (default: regression)
  --user-id <id>              User ID for all requests (default: regression-user)
  --timeout-ms <ms>           Per-request timeout in ms (default: 30000)
  --help                      Show this help

Outputs:
  data/regression-runs/{timestamp}.json   Full run report
  data/regression-runs/latest.json        Latest run (overwritten each run)
  data/cases.json                         Badcase records appended (when --write-badcases)

Environment:
  Reads .env.local for API keys etc (never printed).
`);
}
