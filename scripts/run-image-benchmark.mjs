#!/usr/bin/env node
/**
 * Image Regression Test Script
 *
 * Sends fixtures images to the running dev server's /api/agent endpoint
 * and validates responses against hardcoded expectations.
 *
 * Usage:
 *   npm run benchmark:images
 *   PORT=3001 npm run benchmark:images   # custom port
 *
 * Dependencies: none (uses built-in fetch)
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Config ──

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const BASE_URL = `http://localhost:${PORT}/api/agent`;
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures"
);

// ── Test Cases (hardcoded) ──
// Each test specifies: image file name, query text, and expectations.

const TESTS = [
  {
    image: "tap-list.jpg",
    query: "帮我看这个酒单",
    expect: {
      candidateCount: { min: 1 }, // at least one beer candidate extracted
      intent: "menu_recommend",
      noErrorReply: true,         // reply should not contain error phrases
    },
  },
  {
    image: "测试图片.jpg",
    query: "帮我看这张图",
    expect: {
      candidateCount: { min: 0 }, // may or may not find beer items
      noErrorReply: true,
    },
  },
];

// ── Helpers ──

const MIME_MAP = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function imageToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] ?? "image/jpeg";
  const buf = await readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function inferIntent(response) {
  // Attempt to extract intent from the response structure.
  // The agent may have a mode field, or we infer from candidates/reply.
  if (response.mode === "recommend") return "menu_recommend";
  if (response.candidates?.length > 0) return "menu_recommend";
  return "unclear";
}

function hasErrorPhrase(text) {
  if (!text) return false;
  const phrases = ["出错了", "再试一次", "出错", "发生错误", "请重试"];
  return phrases.some((p) => text.includes(p));
}

// ── Runner ──

async function runTest(test) {
  const imagePath = path.join(FIXTURES_DIR, test.image);
  if (!existsSync(imagePath)) {
    return {
      test,
      status: "SKIP",
      reason: `File not found: ${test.image}`,
    };
  }

  const dataUrl = await imageToDataUrl(imagePath);

  const body = {
    messages: [{ role: "user", content: test.query }],
    image: {
      name: test.image,
      type: dataUrl.split(";")[0].split(":")[1] ?? "image/jpeg",
      dataUrl,
    },
  };

  let response;
  try {
    response = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      test,
      status: "FAIL",
      reason: `Connection refused: is the dev server running on port ${PORT}?`,
      detail: err.message,
    };
  }

  const details = [];

  // Check HTTP status
  if (response.status !== 200) {
    let respBody;
    try {
      respBody = await response.text();
    } catch {
      respBody = "(unreadable)";
    }
    return {
      test,
      status: "FAIL",
      reason: `HTTP ${response.status}`,
      detail: respBody.slice(0, 200),
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      test,
      status: "FAIL",
      reason: "Response is not valid JSON",
      detail: err.message,
    };
  }

  // ── Assertions ──

  // 1. candidateCount
  const candidateCount = data.candidates?.length ?? 0;
  if (test.expect.candidateCount?.min !== undefined) {
    const ok = candidateCount >= test.expect.candidateCount.min;
    details.push({
      name: "candidateCount",
      pass: ok,
      expected: `>= ${test.expect.candidateCount.min}`,
      actual: candidateCount,
    });
  }

  // 2. intent
  if (test.expect.intent) {
    const actualIntent = inferIntent(data);
    const ok = actualIntent === test.expect.intent;
    details.push({
      name: "intent",
      pass: ok,
      expected: test.expect.intent,
      actual: actualIntent,
    });
  }

  // 3. reply should not contain error phrases
  if (test.expect.noErrorReply) {
    const reply = data.reply ?? "";
    const hasError = hasErrorPhrase(reply);
    details.push({
      name: "noErrorReply",
      pass: !hasError,
      expected: "reply without error phrases",
      actual: hasError ? `contains error phrase: "${reply.slice(0, 80)}"` : "ok",
    });
  }

  const allPassed = details.every((d) => d.pass);

  return {
    test,
    status: allPassed ? "PASS" : "FAIL",
    detail: details,
    candidateCount,
    replyPreview: (data.reply ?? "").slice(0, 80),
    responseKeys: Object.keys(data),
  };
}

// ── Main ──

async function main() {
  console.log("\n🧪 Beer Lens Image Regression Test");
  console.log(`   Endpoint: ${BASE_URL}`);
  console.log(`   Fixtures: ${FIXTURES_DIR}`);
  console.log(`   Tests:    ${TESTS.length}\n`);

  const results = [];
  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    process.stdout.write(`[${i + 1}/${TESTS.length}] ${test.image}... `);

    const result = await runTest(test);
    results.push(result);

    if (result.status === "PASS") {
      console.log(`✅ PASS (candidates=${result.candidateCount})`);
    } else if (result.status === "SKIP") {
      console.log(`⏭️  SKIP — ${result.reason}`);
    } else {
      console.log(`❌ FAIL — ${result.reason}`);
      if (Array.isArray(result.detail)) {
        for (const d of result.detail) {
          if (!d.pass) {
            console.log(`   ├─ ${d.name}: expected ${d.expected}, got ${d.actual}`);
          }
        }
      } else if (result.detail) {
        console.log(`   └─ ${result.detail}`);
      }
    }

    if (result.replyPreview) {
      console.log(`   └─ reply: "${result.replyPreview}..."`);
    }
  }

  // ── Summary ──
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 Summary`);
  console.log(`   Total:  ${results.length}`);
  console.log(`   Pass:   ${pass}`);
  console.log(`   Fail:   ${fail}`);
  console.log(`   Skip:   ${skip}`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main();