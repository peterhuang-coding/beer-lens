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
import type { AgentResponse } from "@/lib/beer-agent/types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import { OpenRouterError } from "@/lib/beer-agent/openrouter-client";

// ── Monitoring (side-channel) ──
import {
  recordTurnStart,
  recordTurnEnd,
  recordIntentResult,
  recordHandlerError,
  recordBeerDbLookup,
  recordGuardrailBlock,
  recordUnclearIntent,
  recordPlannerEnd,
  recordPlannerFallback,
  recordPlannerStart,
  resetUnclearStreak,
  startMetricsFlush,
} from "@/lib/beer-agent/monitor/metrics";

// ── Planner Runtime ──
import { shouldUsePlanner, generateRulePlan } from "@/lib/beer-agent/planner/planner";
import { runPlanner, planResultToResponse } from "@/lib/beer-agent/planner/runner";
import { createRegistry } from "@/lib/beer-agent/planner/tools";
import { attachPlannerTrace } from "@/lib/beer-agent/planner/trace";
import { DEFAULT_PLANNER_CONFIG, type PlannerConfig } from "@/lib/beer-agent/planner/types";

// ── Long-term memory & guess ──
import { buildLongTermMemory } from "@/lib/beer-agent/memory/long-term";
import { guessNextBeer } from "@/lib/beer-agent/memory/profile-tag-guess";

// ── Runtime config ──
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

type PipelineConfig = {
  config?: Record<string, Record<string, any>>;
  /** Old-style: simple model name strings (backward-compatible) */
  models?: Record<string, string | ModelConfig>;
  greetings?: Record<string, string>;
  intentOverrides?: Array<{ regex: string; intent: string; note?: string }>;
  prompts?: Record<string, PromptConfig>;
  tools?: Record<string, ToolConfig>;
  planner?: PlannerConfig;
};

export type ModelConfig = {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

export type PromptConfig = {
  id: string;
  name: string;
  content: string;
  version: number;
  updatedAt: string;
  note: string;
};

export type ToolConfig = {
  id: string;
  name: string;
  enabled: boolean;
  timeoutMs: number;
  retry: number;
  notes: string;
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

/** Get a model name from config, falling back to env var or default.
 *  Supports both old-style string ("openai/gpt-4o-mini") and
 *  new-style rich object ({ provider, model, temperature, maxTokens, timeoutMs }). */
export async function getModel(kind: "vision" | "analysis" | "chat" | "intent"): Promise<string> {
  const cfg = await loadConfig();
  const fromConfig = cfg.models?.[kind];
  if (fromConfig) {
    // New-style rich config object
    if (typeof fromConfig === "object" && (fromConfig as ModelConfig).model) {
      return (fromConfig as ModelConfig).model;
    }
    // Old-style plain string
    if (typeof fromConfig === "string") return fromConfig;
  }

  // Fall back to env vars
  const envMap: Record<string, string | undefined> = {
    vision: process.env.OPENROUTER_VISION_MODEL,
    analysis: process.env.OPENROUTER_ANALYSIS_MODEL,
    chat: process.env.OPENROUTER_MODEL,
    intent: process.env.OPENROUTER_MODEL,
  };
  return envMap[kind] ?? "openai/gpt-4o-mini";
}

/** Get full ModelConfig (provider, model, temperature, maxTokens, timeoutMs).
 *  Falls back to sensible defaults when config is old-style string or missing. */
export async function getModelConfig(kind: "vision" | "analysis" | "chat" | "intent" | "embedding"): Promise<ModelConfig> {
  const cfg = await loadConfig();
  const fromConfig = cfg.models?.[kind];

  const defaults: Record<string, ModelConfig> = {
    vision:    { provider: "openrouter", model: "google/gemini-2.5-flash", temperature: 0.1, maxTokens: 12000, timeoutMs: 30000 },
    analysis:  { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0.3, maxTokens: 1500,  timeoutMs: 20000 },
    chat:      { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0.3, maxTokens: 1500,  timeoutMs: 20000 },
    intent:    { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0,   maxTokens: 300,   timeoutMs: 10000 },
    embedding: { provider: "openai",     model: "text-embedding-3-small", temperature: 0,   maxTokens: 512,   timeoutMs: 10000 },
  };

  if (fromConfig && typeof fromConfig === "object" && (fromConfig as ModelConfig).model) {
    return fromConfig as ModelConfig;
  }
  if (typeof fromConfig === "string" && fromConfig) {
    return { ...defaults[kind], model: fromConfig };
  }
  return defaults[kind];
}

/** Get a prompt config by id, with fallback */
export async function getPrompt(id: string, fallbackContent: string): Promise<PromptConfig> {
  const cfg = await loadConfig();
  const fromConfig = cfg.prompts?.[id];
  if (fromConfig) return fromConfig;
  return {
    id,
    name: id,
    content: fallbackContent,
    version: 1,
    updatedAt: new Date().toISOString(),
    note: "default fallback",
  };
}

/** Get a tool config by id, with fallback */
export async function getTool(id: string): Promise<ToolConfig> {
  const cfg = await loadConfig();
  const fromConfig = cfg.tools?.[id];
  if (fromConfig) return fromConfig;
  return {
    id,
    name: id,
    enabled: true,
    timeoutMs: 10000,
    retry: 1,
    notes: "",
  };
}

/** Get a greeting string from config */
export async function getGreeting(key: string, fallback: string): Promise<string> {
  const cfg = await loadConfig();
  return cfg.greetings?.[key] ?? fallback;
}

/** Load planner config from pipeline-config.json with safe defaults. */
async function getPlannerConfig(): Promise<PlannerConfig> {
  const cfg = await loadConfig();
  const plannerCfg = cfg.planner ?? (cfg.config?.planner as Partial<PlannerConfig> | undefined);
  if (!plannerCfg || typeof plannerCfg !== "object") return DEFAULT_PLANNER_CONFIG;
  return {
    enabled: plannerCfg.enabled ?? DEFAULT_PLANNER_CONFIG.enabled,
    maxSteps: plannerCfg.maxSteps ?? DEFAULT_PLANNER_CONFIG.maxSteps,
    defaultMaxSteps: plannerCfg.defaultMaxSteps ?? DEFAULT_PLANNER_CONFIG.defaultMaxSteps,
    llmGenerationEnabled:
      plannerCfg.llmGenerationEnabled ?? DEFAULT_PLANNER_CONFIG.llmGenerationEnabled,
  };
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
  let menuCandidateCount = stm?.lastMenu?.candidates?.length ?? 0;
  // Fallback: parse conversation history for assistant recommendation context
  // This handles VQA-style multi-turn tests where all messages are sent in one API call
  if (menuCandidateCount === 0 && request.messages.length >= 3) {
    const assistantMsgs = request.messages.filter(m => m.role === "assistant");
    for (const msg of assistantMsgs) {
      const content = msg.content || "";
      // Detect prior recommendation: any assistant message with recommendation/beer content
      if (/推荐|评分[\d.]|ABV|酒精度|IBU|ibu|这款|那款|选|建议|试试|可以|好喝|味道/.test(content)) {
        // Extract potential beer names (English or Chinese) from assistant reply
        const beerNames = content.match(/[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*/g);
        if (beerNames && beerNames.length > 0) {
          menuCandidateCount = beerNames.length;
          break;
        }
        // Fallback: Any assistant reply with recommendation-like content → assume 1+ candidates
        menuCandidateCount = Math.max(menuCandidateCount, 1);
      }
    }
  }
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

  // ── Debug info (mutable — route/planner/guardrails enrich it) ──
  const debug: DebugInfo = {
    route: intentResult.intent,
    usedLegacyAgent: undefined,
    hasImage: !!request.image,
    warnings: [],
  };

  // Populate active model names from config for trace diagnostics
  getModelConfig("vision").then((mc) => {
    if (!debug.modelNames) debug.modelNames = {};
    debug.modelNames.vision = mc.model;
  }).catch(() => {});
  getModelConfig("analysis").then((mc) => {
    if (!debug.modelNames) debug.modelNames = {};
    debug.modelNames.analysis = mc.model;
  }).catch(() => {});
  getModelConfig("chat").then((mc) => {
    if (!debug.modelNames) debug.modelNames = {};
    debug.modelNames.chat = mc.model;
  }).catch(() => {});

  // ── Dispatch to intent handler or Planner ──
  let agentResponse;
  let handlerError = false;
  let handlerErrors: Array<{ message: string; stack?: string; model?: string; provider?: string; errorCode?: string }> = [];
  let plannerUsed = false;
  let plannerFallbackUsed = false;
  let plannerStepCount = 0;
  let plannerToolIds: string[] = [];
  let plannerReason = "";

  const runHandler = async () => {
    const handlerContext: HandlerContext = {
      traceId,
      memorySnapshot,
    };
    try {
      const response = await dispatchByIntent(request, intentResult, handlerContext);
      // Collect handler-internal errors (non-thrown fallbacks)
      if (handlerContext.handlerErrors && handlerContext.handlerErrors.length > 0) {
        for (const he of handlerContext.handlerErrors) {
          handlerErrors.push(he);
        }
      }
      return response;
    } catch (err) {
      handlerError = true;
      recordHandlerError(intentResult.intent);
      const errInfo = err instanceof OpenRouterError
        ? { model: err.model, provider: err.provider, errorCode: err.errorCode }
        : {};
      handlerErrors.push({
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ...errInfo,
      });
      console.warn(`[orchestrator] handler "${intentResult.intent}" threw:`, err);
      return {
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
  };

  const plannerConfig = await getPlannerConfig();
  const plannerDecision = plannerConfig.enabled
    ? shouldUsePlanner(intentResult, context)
    : { usePlanner: false, reason: "planner disabled" };

  if (plannerDecision.usePlanner) {
    try {
      plannerUsed = true;
      plannerReason = plannerDecision.reason;
      debug.route = "planner";
      recordPlannerStart();

      const toolRegistry = createRegistry();
      const plan = generateRulePlan(
        plannerDecision.reason,
        {
          intentResult,
          intentContext: context,
          memorySnapshot,
          request,
          traceId,
        },
        Math.min(plannerConfig.defaultMaxSteps, plannerConfig.maxSteps),
      );

      const plannerResult = await runPlanner(plan, toolRegistry, {
        intentResult,
        intentContext: context,
        memorySnapshot,
        request,
        traceId,
      });

      plannerFallbackUsed = plannerResult.fallback;
      plannerStepCount = plannerResult.plan.steps.length;
      plannerToolIds = plannerResult.plan.diagnostics.selectedTools;

      const toolFailures = plannerResult.plan.steps.reduce<Record<string, number>>(
        (acc, step) => {
          if (step.status === "failed") acc[step.tool] = (acc[step.tool] ?? 0) + 1;
          return acc;
        },
        {},
      );
      recordPlannerEnd(plannerResult.success, plannerStepCount, toolFailures);
      if (plannerResult.fallback) recordPlannerFallback();

      agentResponse = planResultToResponse(plannerResult, traceId);
    } catch (err) {
      plannerFallbackUsed = true;
      handlerError = true;
      recordPlannerFallback();
      recordHandlerError("planner");
      console.warn("[orchestrator] planner failed, falling back to handler:", err);
      agentResponse = await runHandler();
      debug.route = intentResult.intent;
    }
  } else {
    agentResponse = await runHandler();
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
  debug.warnings = [...guarded.warnings];
  debug.routeDiagnosis = agentResponse.routeDiagnosis;
  if (plannerUsed) {
    (debug as DebugInfo & { planner?: unknown }).planner = {
      used: true,
      triggerReason: plannerReason,
      fallbackUsed: plannerFallbackUsed,
      stepCount: plannerStepCount,
      toolIds: plannerToolIds,
    };
  }

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
    planner: plannerUsed
      ? {
          used: true,
          triggerReason: plannerReason,
          fallbackUsed: plannerFallbackUsed,
          stepCount: plannerStepCount,
          toolIds: plannerToolIds,
        }
      : undefined,
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
      imageUrl: request.image?.dataUrl,
    },
    intentResult,
    memorySnapshot,
    memoryDelta,
    route: {
      handler: plannerUsed ? "planner" : intentResult.intent,
      diagnosis: agentResponse.routeDiagnosis,
    },
    output: {
      mode: agentResponse.mode,
      reply: guarded.response.reply,
      candidateCount: agentResponse.candidates.length,
      topPickId: agentResponse.picks?.topPick?.candidateId,
    },
    stages: agentResponse.stages ?? undefined,
    errors: handlerErrors,
    debug,
  };

  if (plannerUsed && agentResponse.stages?.planner) {
    const plannerStage = agentResponse.stages.planner as {
      plan?: import("@/lib/beer-agent/planner/types").Plan;
    };
    if (plannerStage.plan) {
      attachPlannerTrace(traceRecord, plannerStage.plan);
    }
  }

  // Fire and forget — trace write failure must not affect the main response
  writeTrace(traceRecord).catch((err) => {
    console.warn("[orchestrator] trace write failed:", err);
  });

  // Auto-create a case record for every turn (raw data analysis)
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
