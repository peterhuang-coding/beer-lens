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

export type RouteLLMResult =
  | { ok: true; decision: RouteDecision; source: "rule" | "llm" }
  | { ok: false; reason: "config" | "upstream" | "parse" | "unknown_skill"; message: string };

/**
 * Pick the best skill via the rule fast-path, then the LLM. The function
 * never throws — every failure mode is converted to `{ok:false, reason}`.
 */
export async function routeByLLM(
  userMessage: string,
  options: { enabledOnly?: boolean; skipRules?: boolean } = {},
): Promise<RouteLLMResult> {
  const { enabledOnly = true, skipRules = false } = options;

  if (!skipRules) {
    const hit = keywordRoute(userMessage, enabledOnly);
    if (hit) {
      return { ok: true, decision: hit, source: "rule" };
    }
  }

  let provider: OpenAICompatibleProvider;
  try {
    provider = new OpenAICompatibleProvider(loadLLMConfig());
  } catch (err) {
    if (err instanceof LLMConfigError) {
      return { ok: false, reason: "config", message: err.message };
    }
    return { ok: false, reason: "config", message: String((err as Error).message ?? err) };
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
    if (err instanceof LLMUpstreamError) {
      return { ok: false, reason: "upstream", message: err.message };
    }
    return { ok: false, reason: "upstream", message: String((err as Error).message ?? err) };
  }

  const decision = parseRouteDecision(raw);
  if (!decision) {
    return { ok: false, reason: "parse", message: `could not parse route JSON: ${raw.slice(0, 80)}` };
  }

  // Defensive validation: if the LLM picked a skill id we don't know, mark
  // it as unknown_skill so the caller can fall back gracefully.
  if (decision.skill_id !== "none") {
    const known = listSkills()
      .filter((s) => (enabledOnly ? s.enabled : true))
      .some((s) => s.id === decision.skill_id);
    if (!known) {
      return {
        ok: false,
        reason: "unknown_skill",
        message: `LLM picked unknown skill: ${decision.skill_id}`,
      };
    }
    const skill = getSkill(decision.skill_id as SkillId);
    if (skill && !skill.enabled && enabledOnly) {
      return {
        ok: false,
        reason: "unknown_skill",
        message: `LLM picked disabled skill: ${decision.skill_id}`,
      };
    }
  }

  return { ok: true, decision, source: "llm" };
}

/** Re-export for callers that don't want to dig into the prompts module. */
export type { RouteDecision };