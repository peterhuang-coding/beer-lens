import { getProfileSummary } from "@/lib/beer-agent/profile";
import { getLastRecommendation } from "@/lib/beer-agent/journal";
import { classifyIntent } from "@/lib/beer-agent/intent-classifier";
import { dispatchByIntent } from "@/lib/beer-agent/dispatcher";
import { createCaseFromTrace } from "@/lib/beer-agent/cases";
import {
  readShortTermMemory,
  updateShortTermMemory,
} from "@/lib/beer-agent/memory/short-term";
import type {
  BeerDialogRequest,
  BeerDialogResponse,
  IntentContext,
  IntentResult,
  MemorySnapshot,
  MemoryDelta,
  DebugInfo,
  TraceRecord,
} from "@/lib/beer-agent/dialog-types";
import { createTraceId, writeTrace } from "@/lib/beer-agent/trace";
import {
  applyPostprocessGuards,
  type PostprocessContext,
} from "@/lib/beer-agent/postprocess/guardrails";

// ── Monitoring (side-channel) ──
import {
  recordTurnStart,
  recordTurnEnd,
  recordIntentResult,
  recordHandlerError,
  recordBeerDbLookup,
  recordGuardrailBlock,
  recordUnclearIntent,
  resetUnclearStreak,
  startMetricsFlush,
} from "@/lib/beer-agent/monitor/metrics";

// ── Long-term memory & guess ──
import { buildLongTermMemory } from "@/lib/beer-agent/memory/long-term";
import { guessNextBeer } from "@/lib/beer-agent/memory/profile-tag-guess";

// ── Runtime config ──
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

type PipelineConfig = {
  config?: Record<string, Record<string, any>>;
  models?: Record<string, string>;
  greetings?: Record<string, string>;
  intentOverrides?: Array<{ regex: string; intent: string; note?: string }>;
};

let _configCache: PipelineConfig | null = null;
let _configCacheTime = 0;

async function loadConfig(): Promise<PipelineConfig> {
  if (_configCache && Date.now() - _configCacheTime < 5000) return _configCache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    _configCache = JSON.parse(raw);
    _configCacheTime = Date.now();
    return _configCache!;
  } catch {
    return {};
  }
}

/** Get a model name from config, falling back to env var or default */
export async function getModel(kind: "vision" | "analysis" | "chat" | "intent"): Promise<string> {
  const cfg = await loadConfig();
  const fromConfig = cfg.models?.[kind];
  if (fromConfig) return fromConfig;

  // Fall back to env vars
  const envMap: Record<string, string | undefined> = {
    vision: process.env.OPENROUTER_VISION_MODEL,
    analysis: process.env.OPENROUTER_ANALYSIS_MODEL,
    chat: process.env.OPENROUTER_MODEL,
    intent: process.env.OPENROUTER_MODEL,
  };
  return envMap[kind] ?? "openai/gpt-4o-mini";
}

/** Get a greeting string from config */
export async function getGreeting(key: string, fallback: string): Promise<string> {
  const cfg = await loadConfig();
  return cfg.greetings?.[key] ?? fallback;
}

// Start periodic metrics flush
startMetricsFlush();

export async function runBeerDialogTurn(
  request: BeerDialogRequest,
): Promise<BeerDialogResponse> {
  const traceId = createTraceId();

  // ── Monitoring: start timer ──
  const turnStartMs = recordTurnStart();

  // ── Intent routing ──
  const lastUserText = request.messages.at(-1)?.content ?? "";
  const hasImage = !!request.image;

  // Fetch profile and last recommendation for both IntentContext and memory snapshot
  let profileSummary: string | undefined;
  let lastRec: Awaited<ReturnType<typeof getLastRecommendation>> | null = null;
  try {
    [profileSummary, lastRec] = await Promise.all([
      getProfileSummary(),
      getLastRecommendation(),
    ]);
  } catch {
    // Silently fall back
  }

  // Read short-term memory for multi-turn context
  const stm = await readShortTermMemory(request.conversationId).catch(() => null);
  const menuCandidateCount = stm?.lastMenu?.candidates?.length ?? 0;
  const turnsSinceMenu = stm?.lastMenu?.createdAt
    ? Math.floor((Date.now() - new Date(stm.lastMenu.createdAt).getTime()) / 60000)
    : 999;

  const context: IntentContext = {
    hasImage,
    lastUserText,
    hasLastMenuCandidates: menuCandidateCount > 0,
    hasLastRecommendation: stm?.lastPicks != null,
    activeMenuCandidateCount: menuCandidateCount,
    turnsSinceLastMenu: turnsSinceMenu,
    profileSummary,
  };

  let intentResult: IntentResult;
  try {
    intentResult = await classifyIntent(request, context);
  } catch (err) {
    console.warn("[orchestrator] classifyIntent failed, using fallback:", err);
    intentResult = {
      intents: [{ intent: "unclear", confidence: 0, slots: {} }],
      intent: "unclear",
      confidence: 0,
      slots: {},
      missingInfo: [],
      routeReason: `classifyIntent threw: ${err instanceof Error ? err.message : "unknown error"}`,
      source: "fallback",
      isMultiIntent: false,
    };
  }

  // ── Monitoring: record intent ──
  recordIntentResult(intentResult.source, intentResult.intent, intentResult.isMultiIntent);

  // Track unclear streak for transfer-to-human
  if (intentResult.intent === "unclear") {
    const needsTransfer = recordUnclearIntent();
    if (needsTransfer) {
      console.log("[orchestrator] transfer-to-human threshold reached for conversation:", request.conversationId);
    }
  } else {
    resetUnclearStreak();
  }

  // ── Memory snapshot (reuse stm from above) ──
  const memorySnapshot: MemorySnapshot = {
    shortTerm: {
      lastMenuCandidateCount: stm?.lastMenu?.candidates?.length,
      hasLastRecommendation: stm?.lastPicks != null,
      activeBeerName: stm?.activeBeer?.displayName ?? null,
    },
    profileSummary,
  };

  // ── Dispatch to intent handler ──
  let agentResponse;
  let handlerError = false;
  try {
    agentResponse = await dispatchByIntent(request, intentResult, {
      traceId,
      memorySnapshot,
    });
  } catch (err) {
    handlerError = true;
    recordHandlerError(intentResult.intent);
    console.warn(`[orchestrator] handler "${intentResult.intent}" threw:`, err);
    agentResponse = {
      mode: "recommend" as const,
      reply: "抱歉，处理你的请求时出错了。请再试一次。",
      candidates: [],
      picks: {
        topPick: { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 },
        safePick: { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 },
        explorePick: { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 },
        avoidOrCaution: { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 },
      },
      profileSummary: "",
    };
  }

  // ── Inject profile tag guess into reply (when appropriate) ──
  if (
    intentResult.intent === "menu_recommend" &&
    agentResponse.candidates.length > 0
  ) {
    try {
      const guess = await guessNextBeer(request.userId);
      if (guess && guess.confidence > 0.6) {
        agentResponse.reply = `${agentResponse.reply}\n\n💡 ${guess.suggestion}`;
      }
    } catch {
      // Guess injection is best-effort
    }
  }

  // ── Record Beer DB hit rate ──
  if (agentResponse.candidates.length > 0) {
    const foundCount = agentResponse.candidates.filter(
      c => c.untappdScore != null && c.untappdScore > 0,
    ).length;
    recordBeerDbLookup(agentResponse.candidates.length, foundCount);
  }

  // ── Postprocess: apply guardrails ──
  const postContext: PostprocessContext = {
    intentResult,
    candidates: agentResponse.candidates,
    allowedBeerNames: agentResponse.candidates.map((c) => c.displayName),
    sourceSummary: {},
  };
  const guarded = await applyPostprocessGuards(agentResponse, postContext);
  if (guarded.blocked) {
    recordGuardrailBlock();
  }

  // ── Infer memory delta ──
  const memoryDelta: MemoryDelta = {
    wroteShortTerm: true,
    wroteEpisodic: intentResult.intent === "tasting_feedback",
    updatedProfile: intentResult.intent === "tasting_feedback",
    notes:
      intentResult.intent === "tasting_feedback"
        ? ["User provided taste feedback — profile updated"]
        : ["Dialog turn completed — no profile change"],
  };

  // ── Debug info ──
  const debug: DebugInfo = {
    route: intentResult.intent,
    usedLegacyAgent: undefined,
    hasImage: !!request.image,
    warnings: [...guarded.warnings],
  };

  // ── Build full response (using guarded reply in case it was blocked) ──
  const response: BeerDialogResponse = {
    ...agentResponse,
    reply: guarded.response.reply,
    traceId,
    userId: request.userId,
    channel: request.channel,
    conversationId: request.conversationId,
    turnId: request.turnId || traceId,
    intentResult,
    memoryDelta,
    debug,
  };

  // ── Monitoring: record end ──
  recordTurnEnd(turnStartMs, !handlerError);

  // ── Trace record (fire-and-forget) ──
  const traceRecord: TraceRecord = {
    traceId,
    userId: request.userId,
    channel: request.channel,
    conversationId: request.conversationId,
    turnId: response.turnId,
    timestamp: new Date().toISOString(),
    input: {
      messageCount: request.messages.length,
      lastUserText: request.messages.at(-1)?.content ?? "",
      hasImage: !!request.image,
      imageName: request.image?.name,
      imageType: request.image?.type,
    },
    intentResult,
    memorySnapshot,
    memoryDelta,
    route: {
      handler: intentResult.intent,
    },
    output: {
      mode: agentResponse.mode,
      reply: guarded.response.reply,
      candidateCount: agentResponse.candidates.length,
      topPickId: agentResponse.picks?.topPick?.candidateId,
    },
    stages: agentResponse.stages ?? undefined,
    errors: [],
    debug,
  };

  // Fire and forget — trace write failure must not affect the main response
  writeTrace(traceRecord).catch((err) => {
    console.warn("[orchestrator] trace write failed:", err);
  });

  // Auto-create a case record for every turn (VQA analysis)
  createCaseFromTrace(traceRecord).catch((err) => {
    console.warn("[orchestrator] case creation failed:", err);
  });

  // Update short-term memory (fire-and-forget)
  updateShortTermMemory(request, response).catch((err) => {
    console.warn("[orchestrator] short-term memory update failed:", err);
  });

  // ── Long-term memory: rebuild if tasting feedback ──
  if (intentResult.intent === "tasting_feedback") {
    buildLongTermMemory(request.userId).catch((err) => {
      console.warn("[orchestrator] long-term memory build failed:", err);
    });
  }

  return response;
}
