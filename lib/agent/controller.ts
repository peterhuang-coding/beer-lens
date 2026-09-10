import { keywordRoute } from "../harness/router-rules.ts";
import { parseMenuInput, hasNamedMenuItems } from "../beer-agent/recommendation/menu-input.ts";
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
): Promise<{ skill: string; reason: string; params: Record<string, unknown>; source: "rule" | "llm" | "fallback" }> {
  await ensureSkillsLoaded();

  // Task #5 — short-circuit BEFORE invoking the LLM.
  const shortCircuit = tryDeterministicShortCircuit(ctx);
  if (shortCircuit && !ctx.hasImage) return {...shortCircuit,source:"rule"};

  // Reuse the public router's fast path, including its image guard and enabled skills.
  await import("@/lib/harness/skill-registry");
  const fast = keywordRoute(ctx.lastUserText,true,undefined,undefined,ctx.hasImage);
  const handlers:Record<string,string> = {menu_recommend:"recommend",follow_up_filter:"recommend",tasting_feedback:"taste-feedback",beer_knowledge:"beer-knowledge",label_check:"label-check",profile_query:"profile-query",memory_correction:"memory-correction",unclear:"fallback",none:"fallback"};
  if (fast) return {skill:handlers[fast.skill_id]??"fallback",params:fast.params,reason:fast.reason,source:"rule"};

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
      model: process.env.OPENROUTER_MODEL ?? "qwen/qwen-2.5-72b-instruct",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0,
    });

    return {...parseSkillSelection(raw),source:"llm"};
  } catch (err) {
    console.warn("[controller] Skill selection failed, using fallback:", err);
    return { skill: "fallback", reason: "LLM selection failed", params: {}, source:"fallback" };
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

  handlerError ||= result.errors.length>0;
  const publicNames:Record<string,string> = {"follow-up-filter":"follow_up_filter",recommend:"menu_recommend","taste-feedback":"tasting_feedback","beer-knowledge":"beer_knowledge","label-check":"label_check","profile-query":"profile_query","memory-correction":"memory_correction","menu-vision":"menu_recommend",fallback:"unclear"};
  let publicIntent = publicNames[handlerError?"fallback":result.skillId]??"unclear";
  if(publicIntent==="menu_recommend" && !ctx.hasImage && !parseMenuInput(ctx.lastUserText).isMenu && !hasNamedMenuItems(parseMenuInput(ctx.lastUserText).items) && (ctx.memorySnapshot?.shortTerm?.lastMenuCandidateCount??0)>0) publicIntent="follow_up_filter";

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

  // Persist the complete public response, including intentResult.
  const response: BeerDialogResponse = {
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
      intents: [{ intent: publicIntent, confidence: 0.9, slots: selection.params }],
      intent: publicIntent,
      confidence: 0.9,
      slots: selection.params,
      missingInfo: [],
      routeReason: selection.reason,
      source: selection.source,
      isMultiIntent: false,
    },
    memoryDelta: {
      wroteShortTerm: false,
      wroteEpisodic: result.data?.wroteEpisodic === true,
      updatedProfile: result.data?.updatedProfile === true,
      notes: [],
    },
    debug: {
      route: selection.skill,
      warnings: result.errors.length > 0 ? result.errors : undefined,
    },
  };
  try {
    await updateShortTermMemory(request,response);
    response.memoryDelta.wroteShortTerm=true;
  } catch(err) {
    response.memoryDelta.notes.push("short-term memory write failed");
    response.debug={...response.debug,route:selection.skill,warnings:[...(response.debug?.warnings??[]),"short-term memory write failed"]};
    console.warn("[controller] short-term memory update failed:",err);
  }
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
      intents: [{ intent: publicIntent, confidence: 0.9, slots: selection.params }],
      intent: publicIntent,
      confidence: 0.9,
      slots: selection.params,
      missingInfo: [],
      routeReason: selection.reason,
      source: selection.source,
      isMultiIntent: false,
    },
    memorySnapshot: ctx.memorySnapshot,
    memoryDelta: response.memoryDelta,
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

  return response;
}
