/**
 * Package-only controller replay — isolated diagnostic tool (Plan H).
 *
 * Runs the REAL controller → skill → vision container → candidate assembly →
 * constraint/decision pipeline against a FIXED package endpoint/model. The
 * model transport is the ONLY substituted layer: tests inject `fetchImpl`;
 * in a parent-run live attempt the captured pre-guard global fetch is used.
 *
 * Safety properties enforced here:
 *  - global fetch deny guard for all product HTTP (OpenRouter/DeepSeek/...)
 *  - one vision submission per run, zero retry/fallback; cache off
 *  - fail-closed receipt gate: any existing receipt evidence other than a
 *    valid completed same-fingerprint receipt (+readable report) blocks; only
 *    ENOENT starts a run and the receipt is created exclusively (wx)
 *  - OPENROUTER_API_KEY presence guard satisfied by a non-credential sentinel
 *    that is never sent anywhere
 *  - cwd/state isolated to a fresh temp dir; empty synthetic DB
 *  - fingerprint + receipt persisted BEFORE the external submission
 *  - untrusted transport text is classified internally into bounded generic
 *    category messages; never copied into report/receipt/warnings/logs
 *  - key, raw image/base64 and data URLs are never written to report/receipt
 *
 * This validates live-model + controller with an isolated empty DB only —
 * NOT Feishu transport and NOT production configuration.
 */

import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { runAgentTurn } from "../../lib/agent/controller.ts";
import { vision, registerProvider } from "../../lib/multimodal/index.ts";
import { getCacheTtl } from "../../lib/multimodal/cache.ts";
import { readShortTermMemory } from "../../lib/beer-agent/memory/short-term.ts";
import type { ChatMessage } from "../../lib/beer-agent/types.ts";
import type {
  BeerDialogRequest,
  BeerDialogResponse,
} from "../../lib/beer-agent/dialog-types.ts";
import type { CapabilityInput } from "../../lib/multimodal/types.ts";
import type {
  ProviderCallOptions,
  VisionProvider,
} from "../../lib/multimodal/providers/base.ts";

// ── Fixed package target ────────────────────────────────────────────────────

export const QA_PROVIDER_ID = "qa-coding-plan";
export const QA_ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
export const QA_MODEL = "doubao-seed-evolving";
export const QA_MAX_TOKENS = 12_000;
export const QA_TIMEOUT_MS = 120_000;
/** Diagnostic-only presence sentinel. NOT a credential; never transmitted. */
export const QA_SENTINEL = "qa-coding-plan-sentinel-not-a-credential";

// ── Public types ────────────────────────────────────────────────────────────

export type QaFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export type PackageControllerReplayOptions = {
  imagePath: string;
  mime: "image/png" | "image/jpeg";
  /** First question accompanies the image; the rest are follow-ups. */
  questions: string[];
  /** Absolute persistent receipt directory. */
  runDir: string;
  apiKey: string;
  /** Injected only for offline tests; otherwise the captured real fetch. */
  fetchImpl?: QaFetchLike;
};

type BlockedAttempt = {
  url: string;
  method: string;
  at: string;
  reason: string;
};

type VisionRecorderResult =
  | {
      status: "ok";
      httpStatus: number;
      durationMs: number;
      returnedModel?: string;
      usage?: unknown;
    }
  | {
      status: "error";
      category: string;
      httpStatus: number | null;
      durationMs: number;
      message: string;
    };

type VisionRecorder = {
  submitted: number;
  rawContent: string | null;
  result: VisionRecorderResult | null;
};

export type PackageControllerReport = {
  schemaVersion: number;
  kind: "package-controller-replay";
  status: "completed" | "failed";
  failureCategory: string | null;
  image: { sha256: string; mime: string; byteLength: number };
  questions: Array<{ index: number; text: string }>;
  turns: Array<Record<string, unknown>>;
  model: {
    requested: Record<string, unknown>;
    returned: { model: string | null; usage: unknown };
  };
  transport: {
    /** Honest delivery label: "injected-fake-transport" or live capture. */
    transportType: string;
    requestCount: number;
    vision: VisionRecorderResult | null;
    blocked: BlockedAttempt[];
  };
  replay: { reused: boolean };
  isolation: { tempDir: string; removedAfterRun: boolean };
  limitations: string[];
};

// ── Errors ──────────────────────────────────────────────────────────────────

class QaVisionError extends Error {
  readonly category: string;
  readonly httpStatus: number | null;
  constructor(category: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "QaVisionError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

/** Keep error text bounded; used ONLY for internal classification. The result
 * is never copied into reports, receipts, warnings or console logs. */
function safeMessage(value: unknown): string {
  const msg = value instanceof Error ? value.message || value.name : String(value);
  return msg.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Bounded generic per-category text. Untrusted transport detail (keys, data
 * URLs, headers, raw messages) never reaches persisted/returned output. */
const QA_CATEGORY_MESSAGES: Record<string, string> = {
  timeout: "qa vision request timed out before returning content",
  transport_error:
    "qa vision transport error: network connection or delivery failure",
  http_error: "qa vision request failed with an HTTP error status",
  rate_limit: "qa vision request rejected: provider rate limit",
  malformed_content: "qa vision response was not a valid JSON envelope",
  empty_content: "qa vision response contained no usable content",
};

function genericCategoryMessage(category: string): string {
  return QA_CATEGORY_MESSAGES[category] ?? "qa vision request failed";
}

/** Reduce a URL to origin + pathname for diagnostics. Userinfo, query and
 * fragment are untrusted and must never be copied into block records/errors. */
function sanitizeUrlForLog(raw: string): string {
  if (!raw) return "unknown-url";
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return "unparseable-url";
  }
}

// ── Global fetch deny guard ─────────────────────────────────────────────────

export function installFetchDenyGuard(): {
  blocked: BlockedAttempt[];
  restore(): void;
} {
  const original = globalThis.fetch;
  const blocked: BlockedAttempt[] = [];
  const deny = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<never> => {
    let url: string;
    let method: string;
    try {
      const rawUrl =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : String(input.url ?? "");
      method =
        typeof input === "string" || input instanceof URL
          ? init?.method ?? "GET"
          : init?.method ?? input.method ?? "GET";
      // Never record userinfo/query/fragment — origin + path only.
      url = sanitizeUrlForLog(rawUrl);
    } catch {
      url = "unparseable-url";
      method = "GET";
    }
    blocked.push({
      url,
      method: String(method).toUpperCase(),
      at: new Date().toISOString(),
      reason: "global fetch deny guard",
    });
    const err = new Error(`blocked by qa fetch deny guard: ${url}`);
    err.name = "QaFetchDeniedError";
    return Promise.reject(err);
  };
  (globalThis as { fetch: unknown }).fetch = deny;
  return {
    blocked,
    restore() {
      (globalThis as { fetch: unknown }).fetch = original;
    },
  };
}

/** Internal hooks exposed for the offline test file only. */
export const __qaInternals = {
  installFetchDenyGuard,
};

// ── Diagnostic vision provider (only sender of a real HTTP request) ─────────

function buildQaProvider(
  apiKey: string,
  transport: QaFetchLike,
  recorder: VisionRecorder,
): VisionProvider {
  return {
    id: QA_PROVIDER_ID,
    async call(
      input: CapabilityInput,
      opts: ProviderCallOptions,
    ): Promise<string> {
      // Defense in depth: the configured chain has one provider/model, but
      // never allow a second submission from this process-side provider.
      if (recorder.submitted >= 1) {
        throw new QaVisionError(
          "transport_error",
          "qa provider refuses a second vision submission",
        );
      }
      recorder.submitted++;

      const maxTokens = Math.min(input.maxTokens ?? QA_MAX_TOKENS, QA_MAX_TOKENS);
      const schemaJson =
        input.schema === undefined ? "" : JSON.stringify(input.schema);

      // Original capability prompt untouched; schema delivered as text.
      const text =
        `${input.prompt}\n\n` +
        "You MUST return ONLY one single JSON object. No markdown, no code fences. " +
        `Follow this JSON schema exactly:\n${schemaJson}`;

      const body: Record<string, unknown> = {
        model: QA_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text },
              {
                type: "image_url",
                image_url: {
                  url: `data:${input.image.mime};base64,${input.image.base64}`,
                },
              },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        stream: false,
        thinking: { type: "enabled" },
        response_format: { type: "json_object" },
      };

      const timeoutMs = Math.min(opts.timeoutMs ?? QA_TIMEOUT_MS, QA_TIMEOUT_MS);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const t0 = Date.now();

      const recordError = (qerr: QaVisionError): never => {
        recorder.result = {
          status: "error",
          category: qerr.category,
          httpStatus: qerr.httpStatus,
          durationMs: Date.now() - t0,
          message: qerr.message,
        };
        throw qerr;
      };

      try {
        const response = await transport(QA_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        const durationMs = Date.now() - t0;
        const httpStatus = response.status;

        if (!response.ok) {
          recordError(
            new QaVisionError(
              httpStatus === 429 ? "rate_limit" : "http_error",
              `qa vision HTTP ${httpStatus}`,
              httpStatus,
            ),
          );
        }

        let envelope: {
          model?: unknown;
          usage?: unknown;
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        try {
          envelope = (await response.json()) as typeof envelope;
        } catch {
          recordError(
            new QaVisionError(
              "malformed_content",
              "qa vision response was not a JSON envelope",
              httpStatus,
            ),
          );
        }

        const returnedModel =
          typeof envelope.model === "string" ? envelope.model : undefined;
        const usage = envelope.usage;
        const content = envelope.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          recorder.result = {
            status: "error",
            category: "empty_content",
            httpStatus,
            durationMs,
            message: "qa vision returned empty content",
          };
          throw new QaVisionError(
            "empty_content",
            "qa vision returned empty content",
            httpStatus,
          );
        }

        recorder.result = {
          status: "ok",
          httpStatus,
          durationMs,
          returnedModel,
          usage,
        };
        recorder.rawContent = content;
        return content;
      } catch (err) {
        if (err instanceof QaVisionError) throw err;
        const aborted =
          abort.signal.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          /timeout|aborted/i.test(safeMessage(err));
        const category = aborted
          ? "timeout"
          : /econn|enotfound|fetch failed|network|reset/i.test(safeMessage(err))
            ? "transport_error"
            : "transport_error";
        recordError(
          new QaVisionError(category, genericCategoryMessage(category), null),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── Env isolation ───────────────────────────────────────────────────────────

const MANAGED_ENV = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_PROXY",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_TITLE",
  "DEEPSEEK_API_KEY",
  "BRAVE_API_KEY",
  "VISION_FALLBACK_MODELS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
];

function applyIsolatedEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    if (key === "OPENROUTER_API_KEY") process.env[key] = QA_SENTINEL;
    else delete process.env[key];
  }
  return () => {
    for (const key of MANAGED_ENV) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// ── Independent validation of model content ────────────────────────────────

function validateCombinedContent(raw: string | null): {
  itemCount: number;
  hasImageContext: boolean;
  hasVisualQuality: boolean;
} | null {
  if (typeof raw !== "string") return null;
  let parsed: {
    imageContext?: unknown;
    visualQuality?: unknown;
    extracted?: { items?: unknown };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const items = parsed.extracted?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  return {
    itemCount: items.length,
    hasImageContext:
      !!parsed.imageContext && typeof parsed.imageContext === "object",
    hasVisualQuality:
      !!parsed.visualQuality && typeof parsed.visualQuality === "object",
  };
}

// ── Report shaping ─────────────────────────────────────────────────────────

function slimCandidate(c: BeerDialogResponse["candidates"][number]) {
  return {
    candidateId: c.candidateId,
    menuIndex: c.menuIndex,
    displayName: c.displayName,
    brewery: c.brewery,
    style: c.style,
    abv: c.abv,
    ibu: c.ibu ?? null,
    price: c.price ?? null,
    currency: c.currency ?? null,
    servingMode: c.servingMode ?? null,
    volumeMl: c.volumeMl ?? null,
    untappdScore: c.untappdScore ?? null,
    riskFlags: c.riskFlags,
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function runPackageControllerReplay(
  options: PackageControllerReplayOptions,
): Promise<PackageControllerReport> {
  const { imagePath, mime, questions, runDir, apiKey, fetchImpl } = options;
  // Honest delivery label recorded in the report: tests inject a fake
  // transport; only a parent-run attempt would use the captured live fetch.
  const transportType = fetchImpl
    ? "injected-fake-transport"
    : "captured-global-fetch-live";

  if (!imagePath || typeof imagePath !== "string") {
    throw new Error("imagePath is required");
  }
  if (mime !== "image/png" && mime !== "image/jpeg") {
    throw new Error("mime must be image/png or image/jpeg");
  }
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.some((q) => typeof q !== "string" || !q.trim())
  ) {
    throw new Error("questions must be a non-empty string array");
  }
  if (!runDir || !path.isAbsolute(runDir)) {
    throw new Error("runDir must be an absolute path");
  }
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("apiKey is required");
  }

  await mkdir(runDir, { recursive: true });
  const receiptPath = path.join(runDir, "receipt.json");
  const reportPath = path.join(runDir, "report.json");

  const imageBytes = await readFile(imagePath);
  const imageSha256 = createHash("sha256")
    .update(imageBytes)
    .digest("hex");

  const fingerprintFields = {
    v: 1,
    kind: "package-controller-replay",
    imageSha256,
    mime,
    questions,
    target: {
      provider: QA_PROVIDER_ID,
      endpoint: QA_ENDPOINT,
      model: QA_MODEL,
    },
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(fingerprintFields))
    .digest("hex");

  // ── Fail-closed receipt gate ──
  // Any existing receipt file is evidence. Only actual ENOENT permits a first
  // submission; everything else must reject WITHOUT calls or overwrites.
  let receiptRaw: string | null = null;
  try {
    receiptRaw = await readFile(receiptPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }

  if (receiptRaw !== null) {
    let receipt: unknown;
    try {
      receipt = JSON.parse(receiptRaw);
    } catch {
      throw new Error(
        `blocked: existing receipt is unreadable/corrupt at ${runDir}`,
      );
    }
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error(
        `blocked: existing receipt is not a receipt object at ${runDir}`,
      );
    }
    const existing = receipt as { status?: unknown; fingerprint?: unknown };
    if (typeof existing.status !== "string") {
      throw new Error(
        `blocked: existing receipt has no valid status at ${runDir}`,
      );
    }

    if (existing.status === "completed") {
      if (
        typeof existing.fingerprint !== "string" ||
        existing.fingerprint !== fingerprint
      ) {
        throw new Error(
          `refuse: fingerprint mismatch for completed receipt at ${runDir}`,
        );
      }
      // A completed receipt is only reusable together with its report.
      let persisted: unknown;
      try {
        persisted = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        throw new Error(
          `blocked: completed receipt is missing its report at ${runDir}`,
        );
      }
      if (
        persisted === null ||
        typeof persisted !== "object" ||
        Array.isArray(persisted)
      ) {
        throw new Error(
          `blocked: completed receipt has an invalid report at ${runDir}`,
        );
      }
      return {
        ...(persisted as PackageControllerReport),
        replay: { reused: true },
      };
    }

    // submitting / unknown / failed / any other state: never resubmit.
    throw new Error(
      `blocked: existing receipt in non-resubmittable state at ${runDir}`,
    );
  }

  // ── Persist fingerprint + state BEFORE external submission ──
  const requestedConfig = {
    provider: QA_PROVIDER_ID,
    endpoint: QA_ENDPOINT,
    model: QA_MODEL,
    maxTokens: QA_MAX_TOKENS,
    timeoutMs: QA_TIMEOUT_MS,
    responseFormat: "json_object",
    thinking: "enabled",
    stream: false,
    temperature: 0.1,
  };
  const initialReceipt = {
    status: "submitting",
    fingerprint,
    fingerprintFields,
    createdAt: new Date().toISOString(),
    image: { sha256: imageSha256, mime, byteLength: imageBytes.length },
    requested: requestedConfig,
  };
  // Exclusive creation: a simultaneous caller that wins the race leaves us
  // with EEXIST — block rather than overwrite their submission.
  try {
    await writeFile(
      receiptPath,
      JSON.stringify(initialReceipt, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") {
      throw new Error(
        `blocked: receipt appeared concurrently (submitting) at ${runDir}`,
      );
    }
    throw err;
  }

  // ── Isolation setup ──
  const restoreEnv = applyIsolatedEnv();
  let guard: ReturnType<typeof installFetchDenyGuard> | null = null;
  let prevCacheTtl = 60_000;
  let isolatedDirName = "";
  let prevCwd = process.cwd();
  let recorder: VisionRecorder = { submitted: 0, rawContent: null, result: null };
  let unexpectedFailure: string | null = null;
  const turnRecords: Array<Record<string, unknown>> = [];

  try {
    const capturedFetch = (
      globalThis as { fetch: typeof fetch }
    ).fetch.bind(globalThis);
    const transport: QaFetchLike = (fetchImpl ??
      (capturedFetch as unknown as QaFetchLike));
    recorder = { submitted: 0, rawContent: null, result: null };
    registerProvider(buildQaProvider(apiKey, transport, recorder));

    prevCacheTtl = getCacheTtl();
    guard = installFetchDenyGuard();

    isolatedDirName = await mkdtemp(
      path.join(tmpdir(), "qa-isolated-state-"),
    );
    vision.config({
      cacheTtlMs: 0,
      capabilityProviders: {
        beer_menu_image: [
          {
            provider: QA_PROVIDER_ID,
            models: [QA_MODEL],
            timeoutMs: QA_TIMEOUT_MS,
          },
        ],
      },
    });
    prevCwd = process.cwd();
    process.chdir(isolatedDirName);

    // ── Turns ──
    const userId = `qa-package-user-${randomBytes(6).toString("hex")}`;
    const conversationId = `qa-package-conv-${randomBytes(6).toString("hex")}`;
    const history: ChatMessage[] = [];

    for (let i = 0; i < questions.length; i++) {
      const request: BeerDialogRequest = {
        userId,
        channel: "cli",
        conversationId,
        turnId: `qa-turn-${i + 1}-${randomBytes(4).toString("hex")}`,
        messages: [...history, { role: "user", content: questions[i] }],
      };
      if (i === 0) {
        request.image = {
          name: path.basename(imagePath),
          type: mime,
          dataUrl: `data:${mime};base64,${imageBytes.toString("base64")}`,
        };
      }

      const response: BeerDialogResponse = await runAgentTurn(request);
      const state = await readShortTermMemory(
        conversationId,
        userId,
      ).catch(() => null);

      const turnRecord: Record<string, unknown> = {
        index: i,
        question: questions[i],
        rawPublicReply: response.reply,
        candidates: response.candidates.map(slimCandidate),
        picks: response.picks,
        storedConstraints: state?.currentConstraints ?? [],
        menuCount: state?.lastMenu?.candidates?.length ?? 0,
        controllerWarnings: response.debug?.warnings ?? [],
      };
      if (i === 0) {
        turnRecord.vision = recorder.result;
        // Independent failure detection — do not trust the polite reply.
        const valid = validateCombinedContent(recorder.rawContent);
        turnRecord.independentVision = valid;
        if (!valid) {
          unexpectedFailure =
            recorder.result?.status === "error"
              ? recorder.result.category
              : "malformed_content";
          turnRecords.push(turnRecord);
          break;
        }
      }

      turnRecords.push(turnRecord);
      history.push(
        { role: "user", content: questions[i] },
        { role: "assistant", content: response.reply },
      );
    }
  } catch {
    unexpectedFailure ??= "transport_error";
    // Error detail is intentionally not retained: untrusted transport text
    // must never reach the report, receipt, warnings or console logs.
  } finally {
    try {
      process.chdir(prevCwd);
    } catch {
      /* cwd may already be gone */
    }
    guard?.restore();
    restoreEnv();
    try {
      vision.config({
        cacheTtlMs: prevCacheTtl,
        capabilityProviders: { beer_menu_image: undefined },
      });
      vision.invalidateCache();
    } catch {
      /* never let config restore break cleanup */
    }
    if (isolatedDirName) {
      await rm(isolatedDirName, { recursive: true, force: true });
    }
  }

  // ── Build + persist the final report ──
  const status: "completed" | "failed" =
    unexpectedFailure === null ? "completed" : "failed";
  const okResult =
    recorder.result?.status === "ok" ? recorder.result : null;

  const limitations =
    fetchImpl !== undefined
      ? [
          "Offline run with an INJECTED FAKE TRANSPORT: image bytes and vision JSON are synthetic; the model endpoint was NOT contacted and no real menu photo was OCR'd in this run.",
          "Validates the actual controller + vision container + candidate/constraint pipeline with an isolated EMPTY DB in a temp cwd.",
          "Does NOT validate Feishu transport, production configuration, real credentials, or real persistence outside runDir.",
          "Live model behavior is unverified until the parent runs the tool in a separate process with an authorized image and key.",
          "Package Chat protocol: 'thinking enabled' only; no claim of native highest reasoning effort (CC execution pins high).",
        ]
      : [
          "LIVE run using the captured global fetch against the fixed package endpoint; the authorized image was sent to the live model and raw image data is not persisted.",
          "Validates the actual controller + vision container + candidate/constraint pipeline with an isolated EMPTY DB in a temp cwd.",
          "Does NOT validate Feishu transport, production configuration, or real persistence outside runDir.",
          "Package Chat protocol: 'thinking enabled' only; no claim of native highest reasoning effort (CC execution pins high).",
        ];

  const report: PackageControllerReport = {
    schemaVersion: 1,
    kind: "package-controller-replay",
    status,
    failureCategory: unexpectedFailure,
    image: {
      sha256: imageSha256,
      mime,
      byteLength: imageBytes.length,
    },
    questions: questions.map((text, index) => ({ index, text })),
    turns: turnRecords,
    model: {
      requested: requestedConfig,
      returned: {
        model: okResult?.returnedModel ?? null,
        usage: okResult?.usage ?? null,
      },
    },
    transport: {
      transportType,
      requestCount: recorder.submitted,
      vision: recorder.result,
      blocked: guard?.blocked ?? [],
    },
    replay: { reused: false },
    isolation: {
      tempDir: isolatedDirName,
      removedAfterRun: true,
    },
    limitations,
  };

  // Persist before flipping the receipt to its terminal state.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const finalReceipt = {
    ...initialReceipt,
    status: status === "completed" ? "completed" : "unknown",
    updatedAt: new Date().toISOString(),
    failureCategory: unexpectedFailure,
  };
  await writeFile(
    receiptPath,
    JSON.stringify(finalReceipt, null, 2) + "\n",
  );

  return report;
}
