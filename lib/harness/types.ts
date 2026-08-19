/**
 * Harness Types — unified skill registry + dispatcher contract.
 *
 * The harness is a thin layer above the existing lib/skills/* and
 * lib/beer-agent/handlers/* paths. It standardises:
 *   - how skill identifiers are named (SkillId),
 *   - how a skill is invoked (SkillContext), and
 *   - what shape the reply takes (AgentReply, compatible with SkillResult).
 *
 * Naming follows `data/intent-registry.json` so consumers can speak either
 * "intent" or "skill" and the harness transparently routes them to the
 * correct executor under lib/skills/.
 */

import type { SkillResult, AgentContext } from "../agent/types.ts";

// ── Skill IDs (mirror data/intent-registry.json; 8 builtin) ──

export type SkillId =
  | "menu_recommend"
  | "follow_up_filter"
  | "tasting_feedback"
  | "profile_query"
  | "beer_knowledge"
  | "label_check"
  | "memory_correction"
  | "unclear";

// ── Invoke context ──

/**
 * The minimal context a skill needs in order to run.
 *
 * `request` is the original BeerDialogRequest (carries channel/user/etc.);
 * `agentContext` is the precomputed LLM-side context (memory/profile/etc.).
 * Keeping both lets the dispatcher be called from either the legacy
 * BeerDialogRequest handler path or the new AgentController path without
 * having to rebuild anything.
 */
export interface SkillContext {
  request: import("../beer-agent/dialog-types.ts").BeerDialogRequest;
  userId: string;
  conversationId: string;
  agentContext?: AgentContext;
  params?: Record<string, unknown>;
  intentMeta?: { source: "rule" | "llm"; confidence: number };
  /**
   * Optional trace context injected by the harness. Carries the chat
   * request's root_ts plus the parent stage that the skill invocation
   * should hang under. Skills do not need to read or write this — the
   * harness uses it internally to emit `skill:invoke` stage entries.
   *
   * Optional so legacy callers (tests, CLI tools) that don't go through
   * the chat route keep working unchanged.
   */
  _trace_ctx?: { root_ts: number; parent_ts: number | null };
}

// ── AgentReply (backward-compatible with SkillResult) ──

/**
 * Unified reply returned by every skill in the harness.
 *
 * Shape matches `SkillResult` from lib/agent/types so existing downstream
 * code (trace, short-term memory update, response shaping) keeps working
 * without an adapter.
 */
export type AgentReply = SkillResult;

// ── Skill definition ──

/**
 * Self-describing skill registration. The registry stores one of these per
 * SkillId. `invoke` is async so the caller can `await` it.
 */
export interface Skill {
  id: SkillId;
  /** Human-readable label, e.g. "酒单推荐" — matches intent-registry label */
  label: string;
  /** Short description used for debugging / future introspection */
  description: string;
  /** Whether the harness should actually dispatch to this skill */
  enabled: boolean;
  /**
   * Preferred source path (informational only — used by the static manifest
   * `data/skills/manifest.json` and not by runtime, which simply calls invoke).
   */
  preferredHandler: "active" | "legacy";
  /** Source module location (for debugging/manifest only) */
  handlerFile: string;
  /** Actual dispatch — invoked through `invokeSkill(id, ctx)` */
  invoke(ctx: SkillContext): Promise<AgentReply>;
}
