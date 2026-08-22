/**
 * Agent Controller — types for the skills-based autonomous agent system.
 *
 * Skills are self-describing capability modules.
 * The Agent Controller uses an LLM to decide which skill(s) to invoke
 * based on user input and conversation context.
 */

import type { ChatMessage, BeerCandidate, Pick } from "@/lib/beer-agent/types";
import type { MemorySnapshot } from "@/lib/beer-agent/dialog-types";

// ── Skill Definition ──

/** A typed parameter a skill accepts */
export type SkillParam = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  description: string;
  required?: boolean;
  default?: unknown;
};

/** Self-describing skill — the LLM reads this to decide when to invoke the skill */
export type SkillDefinition = {
  /** Unique skill id (e.g. "recommend") */
  id: string;
  /** Human-readable name (e.g. "啤酒推荐") */
  name: string;
  /** Description for LLM — when to use this skill, what it does */
  description: string;
  /** Typical trigger phrases (helps LLM match) */
  triggers: string[];
  /** Params the skill accepts */
  params: SkillParam[];
  /** What context this skill needs */
  requiresImage: boolean;
  /** Priority (lower = preferred when multiple skills could apply) */
  priority: number;
};

// ── Skill Execution ──

/** Result from executing a skill */
export type SkillResult = {
  /** The skill that produced this result */
  skillId: string;
  /** Text reply for the user */
  reply: string;
  /** Beer candidates (for recommend skill) */
  candidates: BeerCandidate[];
  /** Recommendation picks */
  picks: {
    topPick: Pick;
    safePick: Pick;
    explorePick: Pick;
    avoidOrCaution: Pick;
  };
  /** Profile summary (for profile-query, tasting) */
  profileSummary: string;
  /** Structured data for potential chained skills */
  data?: Record<string, unknown>;
  /** Whether the skill wants to yield to another skill */
  needsFollowUp?: boolean;
  /** Suggested follow-up skill */
  followUpSkill?: string;
  /** Errors encountered */
  errors: string[];
};

// ── Agent Context ──

/** Shared context passed to skills and available to the LLM */
export type AgentContext = {
  userId: string;
  conversationId: string;
  traceId: string;
  hasImage: boolean;
  imageDataUrl?: string;
  imageName?: string;
  imageType?: string;
  lastUserText: string;
  messages: ChatMessage[];
  channel: string;
  memorySnapshot?: MemorySnapshot;
  profileSummary?: string;
  /** Forwarded from harness SkillContext — long-running stages (vision OCR)
   *  emit progress events here so the chat UI can show them instead of silence. */
  onProgress?: (event: {
    type: string;
    stage?: string;
    label?: string;
    done?: number;
    total?: number;
    count?: number;
    durationMs?: number;
  }) => void;
};

// ── LLM Skill Selection ──

/** What the LLM returns when choosing a skill */
export type SkillSelection = {
  /** Skill id to invoke */
  skill: string;
  /** Reason for selection (for debugging) */
  reason: string;
  /** Params to pass to the skill */
  params: Record<string, unknown>;
  /** Whether this requires chaining another skill */
  needsChain?: boolean;
  /** Secondary skill to chain */
  chainSkill?: string;
};

// ── Agent Turn Result ──

/** Full result of an agent turn (backward-compatible with BeerDialogResponse) */
export type AgentTurnResult = {
  reply: string;
  candidates: BeerCandidate[];
  picks: {
    topPick: Pick;
    safePick: Pick;
    explorePick: Pick;
    avoidOrCaution: Pick;
  };
  mode: "recommend" | "benchmark";
  profileSummary: string;
  traceId: string;
  userId: string;
  channel: string;
  conversationId: string;
  turnId: string;
  /** Which skill was used */
  skillUsed: string;
  /** Skill selection reason (for debugging) */
  skillReason: string;
  /** Whether fallback was used */
  fallback: boolean;
  /** Errors if any */
  errors: string[];
};
