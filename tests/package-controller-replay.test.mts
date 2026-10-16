/**
 * Offline tests for scripts/qa/package-controller.mts.
 *
 * Strict isolation guarantees:
 *  - synthetic image bytes, synthetic combined-vision JSON, synthetic key
 *  - fetch is always injected; the global fetch deny guard blocks everything
 *  - no network, no credentials, no real DB / memory
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

import {
  runPackageControllerReplay,
  QA_ENDPOINT,
  QA_MODEL,
  QA_PROVIDER_ID,
  QA_SENTINEL,
  __qaInternals,
} from "../scripts/qa/package-controller.mts";

// ── Synthetic 1x1 PNG (67 bytes) — never decoded, only hashed/base64'd ──
const PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082";
const IMAGE_BYTES = Buffer.from(PNG_HEX, "hex");
const IMAGE_B64 = IMAGE_BYTES.toString("base64");

const SYNTHETIC_KEY = "synthetic-qa-key-not-real-0123456789";

const QUESTIONS = [
  "帮我推荐，预算不超过100元，ABV不超过8%，想要330ml左右的",
  "第一款多少钱？",
  "换成500ml的，ABV最高10%，预算120",
];

// ── Synthetic combined-vision output: 2 beers, differing price/volume/abv ──
function combinedVisionEnvelope() {
  return {
    id: "chatcmpl-synthetic",
    object: "chat.completion",
    model: QA_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            imageContext: {
              imageType: "menu",
              confidence: 0.96,
              reason: "printed beer menu with two listed offers",
              needsOcr: true,
              needsLabelRecognition: false,
              canAssessVisualQuality: true,
              visibleClues: ["two numbered rows", "prices in CNY"],
            },
            extracted: {
              sourceType: "menu",
              rawText: "1 Tropic Haze ... 2 Midnight Stout ...",
              visualBeerDescription: {
                color: "",
                clarity: "",
                foam: "",
                visiblePackagingDate: "",
                notes: [],
              },
              uncertainties: [],
              items: [
                {
                  menuIndex: 1,
                  rawText:
                    "1. Tropic Haze | Hazy Bros | New England IPA | 6.2% | ¥60 | 330ml",
                  beerName: "Tropic Haze",
                  brewery: "Hazy Bros",
                  style: "New England IPA",
                  abv: 6.2,
                  ibu: 45,
                  price: 60,
                  serving: "330ml",
                  currency: "CNY",
                  servingMode: "draught",
                  packagingDate: "",
                  confidence: 0.95,
                },
                {
                  menuIndex: 2,
                  rawText:
                    "2. Midnight Stout | Dark Mill | Imperial Stout | 9.5% | ¥90 | 500ml",
                  beerName: "Midnight Stout",
                  brewery: "Dark Mill",
                  style: "Imperial Stout",
                  abv: 9.5,
                  ibu: 55,
                  price: 90,
                  serving: "500ml",
                  currency: "CNY",
                  servingMode: "draught",
                  packagingDate: "",
                  confidence: 0.95,
                },
              ],
            },
            visualQuality: {
              canAssess: false,
              visualRiskFlags: ["low_confidence"],
              oxidationRisk: "unknown",
              freshnessRisk: "unknown",
              lightstrikeRisk: "unknown",
              evidence: [],
              caveat: "printed menu; no poured beer visible.",
            },
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

type CapturedCall = { url: string; init: Record<string, unknown> };

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFakeFetch(
  handler: (url: string, init: Record<string, unknown>) => Response | Promise<Response>,
  calls: CapturedCall[],
) {
  return async (url: string | URL | globalThis.Request, init: Record<string, unknown> = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    return handler(u, init);
  };
}

async function setupFiles(imageBytes: Buffer = IMAGE_BYTES) {
  const inputDir = await mkdtemp(path.join(tmpdir(), "qa-input-"));
  const runDir = await mkdtemp(path.join(tmpdir(), "qa-rundir-"));
  const imagePath = path.join(inputDir, "synthetic-menu.png");
  await writeFile(imagePath, imageBytes);
  return { inputDir, runDir, imagePath };
}

function parseRequestBody(call0: CapturedCall): Record<string, any> {
  return JSON.parse(String(call0.init.body));
}

// ── 1. Success: real controller pipeline, exact request fidelity ──

test("success: actual controller follows image → budget/volume/ABV constraints with exact request", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];

  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), calls),
  });

  // ── transport / request fidelity ──
  assert.equal(calls.length, 1, "exactly one external request");
  const call0 = calls[0];
  assert.equal(call0.url, QA_ENDPOINT);
  assert.equal(call0.init.method, "POST");
  const headers = call0.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["authorization"], `Bearer ${SYNTHETIC_KEY}`);

  const body = parseRequestBody(call0);
  assert.equal(body.model, QA_MODEL);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.max_tokens, 12000);
  assert.equal(body.temperature, 0.1);

  // Original prompt verbatim, schema appended as text (schema must not be
  // delivered via strict json_schema — json_object + text only).
  assert.ok(Array.isArray(body.messages) && body.messages.length === 1);
  const parts = body.messages[0].content as Array<Record<string, unknown>>;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "text");
  const text = String((parts[0] as any).text);
  assert.ok(text.startsWith("你是啤酒图像分析器"), "original capability prompt preserved at start");
  assert.ok(text.includes(QUESTIONS[0]), "original user requirement embedded in prompt");
  assert.ok(text.includes('"imageContext"'), "JSON schema appended as text");
  assert.ok(text.includes("visualQuality"));
  assert.equal(parts[1].type, "image_url");
  assert.deepEqual((parts[1] as any).image_url, {
    url: `data:image/png;base64,${IMAGE_B64}`,
  });

  // ── report basics ──
  assert.equal(report.status, "completed");
  assert.equal(report.image.sha256.length, 64);
  assert.equal(report.image.byteLength, IMAGE_BYTES.length);
  assert.equal(report.image.mime, "image/png");
  assert.equal(report.turns.length, 3);
  assert.equal(report.transport.requestCount, 1);
  assert.equal(report.model.requested.endpoint, QA_ENDPOINT);
  assert.equal(report.model.requested.model, QA_MODEL);
  assert.equal(report.model.requested.provider, QA_PROVIDER_ID);
  assert.equal(report.model.returned.model, QA_MODEL);
  assert.deepEqual(report.model.returned.usage, {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });

  // ── turn 1: image + budget/ABV/around-volume constraints ──
  const t0 = report.turns[0];
  assert.equal(t0.menuCount, 2);
  assert.equal(t0.candidates.length, 2);
  const a = t0.candidates.find((c) => c.candidateId === "ocr_1")!;
  const b = t0.candidates.find((c) => c.candidateId === "ocr_2")!;
  assert.equal(a.displayName, "Tropic Haze");
  assert.equal(a.price, 60);
  assert.equal(a.volumeMl, 330);
  assert.equal(a.abv, 6.2);
  assert.equal(a.currency, "CNY");
  assert.equal(b.price, 90);
  assert.equal(b.volumeMl, 500);
  assert.equal(b.abv, 9.5);
  assert.equal(t0.picks.topPick.candidateId, "ocr_1", "only A fits ¥100 / ≤8% / ~330ml");
  for (const token of ["maxPrice:100", "maxAbv:8", "aroundVolumeMl:330"]) {
    assert.ok(t0.storedConstraints.includes(token), `stored ${token}`);
  }
  assert.ok(b.riskFlags.length > 0, "ineligible candidate keeps risk/failure flags");

  // ── turn 2: ordinal fact question, stored constraints retained ──
  const t1 = report.turns[1];
  assert.equal(t1.menuCount, 2);
  assert.match(t1.rawPublicReply, /60/);
  for (const token of ["maxPrice:100", "maxAbv:8", "aroundVolumeMl:330"]) {
    assert.ok(t1.storedConstraints.includes(token));
  }

  // ── turn 3: relaxed/replaced constraints flip the pick ──
  const t2 = report.turns[2];
  assert.equal(t2.picks.topPick.candidateId, "ocr_2", "500ml / ≤10% / ¥120 admits B only");
  for (const token of ["volumeMl:500", "maxAbv:10", "maxPrice:120"]) {
    assert.ok(t2.storedConstraints.includes(token), `stored ${token}`);
  }
  assert.ok(!t2.storedConstraints.includes("aroundVolumeMl:330"));
  assert.ok(!t2.storedConstraints.includes("maxPrice:100"));

  // Receipt completed and persisted under runDir.
  const receipt = JSON.parse(await readFile(path.join(runDir, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "completed");
  assert.ok(receipt.fingerprint);
  const persistedReport = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8"));
  assert.equal(persistedReport.status, "completed");
});

// ── 2. HTTP 429 ──

test("failure: HTTP 429 stops run, terminal unknown receipt, no fallback", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];
  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(
      () => jsonResponse({ error: { message: "rate limited", code: 429 } }, { status: 429 }),
      calls,
    ),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failureCategory, "rate_limit");
  assert.equal(calls.length, 1, "no retry");
  assert.equal(report.turns.length, 1, "remaining questions stopped");
  assert.equal(report.transport.vision.status, "error");
  assert.equal(report.transport.vision.httpStatus, 429);
  const receipt = JSON.parse(await readFile(path.join(runDir, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "unknown");
});

// ── 3. Timeout (simulated abort-class transport error) ──

test("failure: timeout-class abort", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];
  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "AbortError";
      throw err;
    }, calls),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failureCategory, "timeout");
  assert.equal(calls.length, 1);
  assert.equal(report.model.requested.timeoutMs <= 120_000, true);
  const receipt = JSON.parse(await readFile(path.join(runDir, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "unknown");
});

// ── 4. Transport error ──

test("failure: transport error", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];
  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => {
      throw new Error("fetch failed: ECONNRESET");
    }, calls),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failureCategory, "transport_error");
  assert.equal(calls.length, 1);
  const receipt = JSON.parse(await readFile(path.join(runDir, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "unknown");
});

// ── 5. Empty content ──

test("failure: empty model content", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];
  const envelope = combinedVisionEnvelope();
  envelope.choices[0].message.content = "";
  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => jsonResponse(envelope), calls),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failureCategory, "empty_content");
  assert.equal(calls.length, 1);
});

// ── 6. Malformed outer envelope ──

test("failure: malformed JSON envelope", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];
  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => jsonResponse("this-is-not-json"), calls),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failureCategory, "malformed_content");
  assert.equal(calls.length, 1);
});

// ── 7. Polite error text must not be mistaken for success ──

test("failure: polite text reply detected independently", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls: CapturedCall[] = [];
  const envelope = combinedVisionEnvelope();
  envelope.choices[0].message.content = "Sorry, I cannot analyze this image right now.";
  const report = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => jsonResponse(envelope), calls),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failureCategory, "malformed_content");
  assert.equal(calls.length, 1);
  assert.equal(report.turns.length, 1);
});

// ── 8. Idempotency: replay reuse, mismatch refusal, terminal block ──

test("idempotency: completed receipt reused; different input refuses; terminal blocks", async () => {
  const { runDir, imagePath } = await setupFiles();
  const calls1: CapturedCall[] = [];
  const first = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), calls1),
  });
  assert.equal(first.status, "completed");
  assert.equal(calls1.length, 1);

  // Identical replay → reused, no resend.
  const calls2: CapturedCall[] = [];
  const second = await runPackageControllerReplay({
    imagePath,
    mime: "image/png",
    questions: QUESTIONS,
    runDir,
    apiKey: SYNTHETIC_KEY,
    fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), calls2),
  });
  assert.equal(second.status, "completed");
  assert.equal(second.replay.reused, true);
  assert.equal(calls2.length, 0, "persisted receipt prevents resend");

  // Different image → refuses.
  const altInput = await setupFiles(Buffer.from("different-synthetic-bytes-0002", "utf8"));
  await assert.rejects(
    runPackageControllerReplay({
      imagePath: altInput.imagePath,
      mime: "image/png",
      questions: QUESTIONS,
      runDir,
      apiKey: SYNTHETIC_KEY,
      fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), []),
    }),
    /fingerprint|refuse/i,
  );

  // Different questions → refuses.
  await assert.rejects(
    runPackageControllerReplay({
      imagePath,
      mime: "image/png",
      questions: ["完全不同的问题"],
      runDir,
      apiKey: SYNTHETIC_KEY,
      fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), []),
    }),
    /fingerprint|refuse/i,
  );

  // Existing terminal (unknown) receipt blocks replay.
  const terminal = await setupFiles();
  const terminalCalls: CapturedCall[] = [];
  await writeFile(
    path.join(terminal.runDir, "receipt.json"),
    JSON.stringify({ status: "unknown", fingerprint: "stale" }),
  );
  await assert.rejects(
    runPackageControllerReplay({
      imagePath: terminal.imagePath,
      mime: "image/png",
      questions: QUESTIONS,
      runDir: terminal.runDir,
      apiKey: SYNTHETIC_KEY,
      fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), terminalCalls),
    }),
    /blocked|terminal|submitting/i,
  );
  assert.equal(terminalCalls.length, 0);

  // Submitting receipt also blocks.
  const submitting = await setupFiles();
  await writeFile(
    path.join(submitting.runDir, "receipt.json"),
    JSON.stringify({ status: "submitting", fingerprint: "stale" }),
  );
  await assert.rejects(
    runPackageControllerReplay({
      imagePath: submitting.imagePath,
      mime: "image/png",
      questions: QUESTIONS,
      runDir: submitting.runDir,
      apiKey: SYNTHETIC_KEY,
      fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), []),
    }),
    /blocked|terminal|submitting/i,
  );
});

// ── 9. Restoration + secret redaction + inherited credentials ──

test("restoration: cwd/env/fetch restored; secrets and image bytes never persisted", async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "inherited-synthetic-credential-AZKJ9";
  let tempDir = "";
  try {
    const { runDir, imagePath } = await setupFiles();
    const report = await runPackageControllerReplay({
      imagePath,
      mime: "image/png",
      questions: QUESTIONS,
      runDir,
      apiKey: SYNTHETIC_KEY,
      fetchImpl: makeFakeFetch(() => jsonResponse(combinedVisionEnvelope()), []),
    });
    tempDir = report.isolation.tempDir;

    // Process state restored.
    assert.equal(process.cwd(), originalCwd);
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(process.env.OPENROUTER_API_KEY, "inherited-synthetic-credential-AZKJ9");
    assert.equal(report.isolation.removedAfterRun, true);
    await assert.rejects(access(tempDir), /ENOENT/);

    // runDir remains.
    await access(path.join(runDir, "report.json"));
    await access(path.join(runDir, "receipt.json"));

    // Secrets / raw bytes never written.
    const reportText = await readFile(path.join(runDir, "report.json"), "utf8");
    const receiptText = await readFile(path.join(runDir, "receipt.json"), "utf8");
    const serialized = JSON.stringify(report);
    for (const leak of [
      SYNTHETIC_KEY,
      "inherited-synthetic-credential-AZKJ9",
      QA_SENTINEL,
      IMAGE_B64,
      "data:image/png;base64,",
    ]) {
      assert.ok(!reportText.includes(leak), `report leaks ${leak.slice(0, 12)}`);
      assert.ok(!receiptText.includes(leak), `receipt leaks ${leak.slice(0, 12)}`);
      assert.ok(!serialized.includes(leak), `returned report leaks ${leak.slice(0, 12)}`);
    }
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    if (tempDir) {
      // best-effort; the tool is expected to have removed it already
    }
  }
});

// ── 10. Global fetch deny guard blocks product HTTP and records attempts ──

test("fetch deny guard: blocks and records product HTTP without sending", async () => {
  const guard = __qaInternals.installFetchDenyGuard();
  try {
    await assert.rejects(
      globalThis.fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer whatever" },
      }),
      /deny guard/i,
    );
    await assert.rejects(globalThis.fetch("https://api.deepseek.com/test"), /deny guard/i);
    assert.equal(guard.blocked.length, 2);
    assert.match(guard.blocked[0].url, /openrouter/);
    assert.equal(guard.blocked[0].method, "POST");
    assert.match(guard.blocked[1].url, /deepseek/);
  } finally {
    guard.restore();
  }
  assert.equal(typeof globalThis.fetch, "function");
});
