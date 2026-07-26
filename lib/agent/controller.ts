/**
 * Agent Controller — LLM-driven autonomous skill dispatcher.
 *
 * This replaces the old hardcoded intent-router + orchestrator.
 *
 * Flow:
 *   1. Build AgentContext (memory, profile, conversation)
 *   2. Generate skill selection prompt with available skills
 *   3. LLM chooses the best skill for the user's input
 *   4. Execute the skill
 *   5. Return result (backward-compatible with the old BeerDialogResponse)
 */

import type { BeerDialogRequest, BeerDialogResponse } from "@/lib/beer-agent/dialog-types";
import type { AgentTurnResult, SkillResult } from "./types";
import { buildAgentContext, describeContext } from "./context";
import { buildSkillPrompt, parseSkillSelection, ensureSkillsLoaded, getSkill } from "./skill-registry";
import { openrouterFetch } from "@/lib/beer-agent/openrouter-client";
import { writeTrace } from "@/lib/beer-agent/trace";
import { updateShortTermMemory } from "@/lib/beer-agent/memory/short-term";
import {
  recordTurnStart,
  recordTurnEnd,
  recordHandlerError,
} from "@/lib/beer-agent/monitor/metrics";

// ── Skill executors (dynamic imports to avoid circular deps) ──

const skillExecutors: Record<string, (ctx: import("./types").AgentContext, params: Record<string, unknown>) => Promise<SkillResult>> = {
  recommend: async (ctx, params) => {
    const { execute } = await import("@/lib/skills/recommend/execute");
    return execute(ctx, params);
  },
  "taste-feedback": async (ctx, params) => {
    const { execute } = await import("@/lib/skills/taste-feedback/execute");
    return execute(ctx, params);
  },
  "beer-knowledge": async (ctx, params) => {
    const { execute } = await import("@/lib/skills/beer-knowledge/execute");
    return execute(ctx, params);
  },
  "label-check": async (ctx, params) => {
    const { execute } = await import("@/lib/skills/label-check/execute");
    return execute(ctx, params);
  },
  "profile-query": async (ctx, params) => {
    const { execute } = await import("@/lib/skills/profile-query/execute");
    return execute(ctx, params);
  },
  "memory-correction": async (ctx, params) => {
    const { execute } = await import("@/lib/skills/memory-correction/execute");
    return execute(ctx, params);
  },
  "menu-vision": async (ctx, params) => {
    const { execute } = await import("@/lib/skills/menu-vision/execute");
    return execute(ctx, params);
  },
  fallback: async (ctx, _params) => {
    const { execute } = await import("@/lib/skills/fallback/execute");
    return execute(ctx, {});
  },
};

// ── Empty picks default ──

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

// ── LLM Skill Selection ──

/**
 * Task #5 — deterministic short-circuit BEFORE invoking the LLM skill selector.
 *
 * Short, obviously-underspecified prompts ("哪款?", "哪一款?", "这个?", "hello",
 * "hi") are routed straight to the `recommend` skill when there is an active menu.
 * This avoids spending an LLM round-trip (cost + latency) on questions the rules
 * can answer with high confidence, and aligns with the matching regex family in
 * `lib/beer-agent/intent-registry.ts`.
 *
 * If no active menu is detected, we fall through to the LLM so the user gets a
 * polite "please share a menu first" reply via the regular path.
 */
function tryDeterministicShortCircuit(
  ctx: import("./types").AgentContext,
): { skill: string; reason: string; params: Record<string, unknown> } | null {
  const lastText = (ctx.lastUserText || "").trim();
  if (lastText.length === 0 || lastText.length > 12) return null;

  const patterns: RegExp[] = [
    /^(哪款|哪一款|哪一种|哪一杯|哪一个)\s*[?？。.\s]*$/i,
    /^这个\s*[?？。.\s]*$/i,
    /^(hello|hi|hey|你好|在吗)\s*[!！?？。.\s]*$/i,
  ];
  if (!patterns.some((p) => p.test(lastText))) return null;

  // Active menu present in memory snapshot? (Populated by buildAgentContext)
  if ((ctx.memorySnapshot?.shortTerm?.lastMenuCandidateCount ?? 0) > 0) {
    return {
      skill: "recommend",
      reason: "deterministic short-question with active menu",
      params: {},
    };
  }
  // Let the LLM handle the polite-fallback reply for cold-start greetings.
  return null;
}

async function selectSkill(
  ctx: import("./types").AgentContext,
): Promise<{ skill: string; reason: string; params: Record<string, unknown> }> {
  await ensureSkillsLoaded();

  // Task #5 — short-circuit BEFORE invoking the LLM.
  const shortCircuit = tryDeterministicShortCircuit(ctx);
  if (shortCircuit) return shortCircuit;

  const prompt = buildSkillPrompt(ctx.hasImage);
  const userPrompt = [
    `用户输入：${ctx.lastUserText}`,
    `上下文：${describeContext(ctx)}`,
    `最近对话：${ctx.messages.slice(-4).map(m => `[${m.role}] ${m.content.slice(0, 100)}`).join(" | ")}`,
    "",
    "请选择最合适的技能：",
  ].join("\n");

  try {
    const raw = await openrouterFetch({
      model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0,
    });

    return parseSkillSelection(raw);
  } catch (err) {
    console.warn("[controller] Skill selection failed, using fallback:", err);
    return { skill: "fallback", reason: "LLM selection failed", params: {} };
  }
}

// ── Main Entry Point ──

export async function runAgentTurn(
  request: BeerDialogRequest,
): Promise<BeerDialogResponse> {
  const turnStartMs = recordTurnStart();

  // 1. Build context
  const ctx = await buildAgentContext(request);

  // 2. Ensure skills are loaded
  await ensureSkillsLoaded();

  // 3. LLM selects skill
  const selection = await selectSkill(ctx);

  // 4. Execute skill
  let result: SkillResult;
  let handlerError = false;

  const executor = skillExecutors[selection.skill];
  if (!executor) {
    console.warn(`[controller] Unknown skill "${selection.skill}", using fallback`);
    handlerError = true;
    result = await skillExecutors["fallback"](ctx, {});
  } else {
    try {
      result = await executor(ctx, selection.params);
    } catch (err) {
      handlerError = true;
      recordHandlerError(selection.skill);
      console.warn(`[controller] Skill "${selection.skill}" threw:`, err);
      result = {
        skillId: "fallback",
        reply: "抱歉，处理你的请求时出错了。请再试一次。",
        candidates: [],
        picks: emptyPicks(),
        profileSummary: ctx.profileSummary ?? "",
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  // 5. Build response (backward compatible)
  const turnResult: AgentTurnResult = {
    reply: result.reply,
    candidates: result.candidates,
    picks: result.picks,
    mode: "recommend",
    profileSummary: result.profileSummary || ctx.profileSummary || "",
    traceId: ctx.traceId,
    userId: request.userId,
    channel: request.channel,
    conversationId: request.conversationId,
    turnId: request.turnId || ctx.traceId,
    skillUsed: selection.skill,
    skillReason: selection.reason,
    fallback: handlerError || selection.skill === "fallback",
    errors: result.errors,
  };

  // 6. Metrics
  recordTurnEnd(turnStartMs, !handlerError);

  // 7. Trace (fire-and-forget)
  writeTrace({
    traceId: ctx.traceId,
    userId: request.userId,
    channel: request.channel,
    conversationId: request.conversationId,
    turnId: turnResult.turnId,
    timestamp: new Date().toISOString(),
    input: {
      messageCount: request.messages.length,
      lastUserText: ctx.lastUserText,
      hasImage: ctx.hasImage,
    },
    intentResult: {
      intents: [{ intent: selection.skill, confidence: 0.9, slots: selection.params }],
      intent: selection.skill,
      confidence: 0.9,
      slots: selection.params,
      missingInfo: [],
      routeReason: selection.reason,
      source: "llm",
      isMultiIntent: false,
    },
    memorySnapshot: ctx.memorySnapshot,
    memoryDelta: {
      wroteShortTerm: true,
      wroteEpisodic: false,
      updatedProfile: false,
      notes: [`Skill: ${selection.skill}`],
    },
    route: {
      handler: selection.skill,
    },
    output: {
      mode: "recommend",
      reply: result.reply,
      candidateCount: result.candidates.length,
      topPickId: result.picks.topPick?.candidateId,
    },
    errors: result.errors.map(e => ({ message: e })),
  } as import("@/lib/beer-agent/dialog-types").TraceRecord).catch((err) => {
    console.warn("[controller] trace write failed:", err);
  });

  // 8. Update short-term memory (fire-and-forget)
  updateShortTermMemory(request, turnResult as unknown as BeerDialogResponse).catch((err) => {
    console.warn("[controller] short-term memory update failed:", err);
  });

  // 9. Return as BeerDialogResponse
  return {
    reply: turnResult.reply,
    candidates: turnResult.candidates,
    picks: turnResult.picks,
    mode: turnResult.mode,
    profileSummary: turnResult.profileSummary,
    traceId: turnResult.traceId,
    userId: turnResult.userId,
    channel: turnResult.channel as import("@/lib/beer-agent/dialog-types").BeerChannel,
    conversationId: turnResult.conversationId,
    turnId: turnResult.turnId,
    intentResult: {
      intents: [{ intent: selection.skill, confidence: 0.9, slots: selection.params }],
      intent: selection.skill,
      confidence: 0.9,
      slots: selection.params,
      missingInfo: [],
      routeReason: selection.reason,
      source: "llm" as const,
      isMultiIntent: false,
    },
    memoryDelta: {
      wroteShortTerm: true,
      wroteEpisodic: false,
      updatedProfile: false,
      notes: [],
    },
    debug: {
      route: selection.skill,
      warnings: result.errors.length > 0 ? result.errors : undefined,
    },
  };
}
