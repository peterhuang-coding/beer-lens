/**
 * Harness Router — LLM-side helper.
 *
 * `routeByLLM` is the LLM-as-Router entry point. Given a user message and
 * an optional set of enabled skill ids, it asks the LLM which skill to
 * invoke and returns a `{skill_id, params}` decision (or `{skill_id:"none"}`
 * when no skill fits).
 *
 * Two-stage routing:
 *   1. `keywordRoute` does a fast rule-based match on Chinese keywords.
 *      If a high-confidence match is found we skip the LLM entirely.
 *   2. Otherwise we ask the LLM. The function never throws on a missing
 *      LLM config — it returns a `{ok:false, reason}` instead so the
 *      caller can fall back. This keeps the router usable when the
 *      upstream API is down or unconfigured.
 *
 * No state is stored here; callers can `await routeByLLM(...)` as needed.
 */

import { OpenAICompatibleProvider } from "./llm/openai-compatible.ts";
import {
  buildIntentClassifierMessages,
  parseRouteDecision,
  type RouteDecision,
} from "./llm/prompts/intent-classifier.ts";
import { LLMConfigError, LLMUpstreamError } from "./llm/provider.ts";
import { loadLLMConfig } from "./llm/config.ts";
import { listSkills, getSkill } from "./router.ts";
import { keywordRoute } from "./router-rules.ts";
import type { SkillId } from "./types.ts";
import { appendStage } from "./trace-buffer.ts";

export type RouteLLMResult =
  | { ok: true; decision: RouteDecision; source: "rule" | "llm" }
  | { ok: false; reason: "config" | "upstream" | "parse" | "unknown_skill"; message: string };

/**
 * Pick the best skill via the rule fast-path, then the LLM. The function
 * never throws — every failure mode is converted to `{ok:false, reason}`.
 *
 * When `root_ts` is provided, three stage entries are emitted to the trace
 * buffer so the trace tree shows the routing path:
 *   - `route:enter`  — request reached the router (rule path or LLM path)
 *   - `llm:classify` — only when the LLM was actually consulted, carries
 *                      the parsed decision and which skill was picked
 *   - `route:error`  — any `{ok:false}` return path (config / upstream /
 *                      parse / unknown_skill)
 */
export async function routeByLLM(
  userMessage: string,
  options: { enabledOnly?: boolean; skipRules?: boolean; root_ts?: number; parent_ts?: number | null } = {},
): Promise<RouteLLMResult> {
  const { enabledOnly = true, skipRules = false, root_ts, parent_ts } = options;
  const traceOn = typeof root_ts === "number";
  const pt = parent_ts ?? root_ts ?? null;
  const traceAppend = (stage: string, partial: Parameters<typeof appendStage>[3]) => {
    if (!traceOn) return;
    try { appendStage(root_ts!, pt, stage, partial); } catch { /* never let tracing kill routing */ }
  };

  traceAppend("route:enter", { decision: { skip_rules: skipRules, msg_preview: userMessage.slice(0, 80) } });

  if (!skipRules) {
    const hit = keywordRoute(userMessage, enabledOnly, root_ts, parent_ts);
    if (hit) {
      traceAppend("route:exit", { decision: { source: "rule", skill_id: hit.skill_id } });
      return { ok: true, decision: hit, source: "rule" };
    }
  }

  let provider: OpenAICompatibleProvider;
  try {
    provider = new OpenAICompatibleProvider(loadLLMConfig());
  } catch (err) {
    const reason = err instanceof LLMConfigError ? "config" : "config";
    const msg = err instanceof LLMConfigError ? err.message : String((err as Error).message ?? err);
    traceAppend("route:error", { ok: false, decision: { reason, message: msg.slice(0, 200) } });
    return { ok: false, reason, message: msg };
  }

  const messages = buildIntentClassifierMessages(userMessage, enabledOnly);
  let raw: string;
  try {
    raw = await provider.completeText({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.2,
      maxTokens: 400,
      stream: true,
    });
  } catch (err) {
    const reason = "upstream";
    const msg = err instanceof LLMUpstreamError ? err.message : String((err as Error).message ?? err);
    traceAppend("route:error", { ok: false, decision: { reason, message: msg.slice(0, 200) } });
    return { ok: false, reason, message: msg };
  }

  const decision = parseRouteDecision(raw);
  if (!decision) {
    traceAppend("route:error", { ok: false, decision: { reason: "parse", raw_preview: raw.slice(0, 80) } });
    return { ok: false, reason: "parse", message: `could not parse route JSON: ${raw.slice(0, 80)}` };
  }

  traceAppend("llm:classify", { decision: { skill_id: decision.skill_id, reason: decision.reason, params_keys: Object.keys(decision.params ?? {}) } });

  // Defensive validation: if the LLM picked a skill id we don't know, mark
  // it as unknown_skill so the caller can fall back gracefully.
  if (decision.skill_id !== "none") {
    const known = listSkills()
      .filter((s) => (enabledOnly ? s.enabled : true))
      .some((s) => s.id === decision.skill_id);
    if (!known) {
      traceAppend("route:error", { ok: false, decision: { reason: "unknown_skill", skill_id: decision.skill_id } });
      return {
        ok: false,
        reason: "unknown_skill",
        message: `LLM picked unknown skill: ${decision.skill_id}`,
      };
    }
    const skill = getSkill(decision.skill_id as SkillId);
    if (skill && !skill.enabled && enabledOnly) {
      traceAppend("route:error", { ok: false, decision: { reason: "unknown_skill", skill_id: decision.skill_id, disabled: true } });
      return {
        ok: false,
        reason: "unknown_skill",
        message: `LLM picked disabled skill: ${decision.skill_id}`,
      };
    }
  }

  traceAppend("route:exit", { decision: { source: "llm", skill_id: decision.skill_id } });
  return { ok: true, decision, source: "llm" };
}

/** Re-export for callers that don't want to dig into the prompts module. */
export type { RouteDecision };