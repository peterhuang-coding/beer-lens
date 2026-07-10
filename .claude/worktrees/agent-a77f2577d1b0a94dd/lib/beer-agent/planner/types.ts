/**
 * Planner Runtime — core data structures.
 *
 * The planner converts complex multi-step beer recommendation tasks into
 * structured, traceable plans executed through a whitelist tool registry.
 */

import type {
  IntentResult,
  IntentContext,
  MemorySnapshot,
  BeerDialogRequest,
} from "@/lib/beer-agent/dialog-types";
import type { BeerCandidate, Pick, AgentResponse } from "@/lib/beer-agent/types";

// ── Tool IDs (whitelist) ──

export const PLANNER_TOOL_IDS = [
  "classify_intent",
  "retrieve_memory",
  "search_beer_db",
  "score_recommendations",
  "update_profile_correction",
  "ask_clarifying_question",
  "compose_answer",
  "analyze_image", // future: vision pipeline wrapper
] as const;

export type PlanToolId = (typeof PLANNER_TOOL_IDS)[number];

// ── Step status ──

export type PlanStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

// ── Plan step ──

export type PlanStep = {
  /** Unique within the plan (e.g. "step_1") */
  id: string;
  /** Tool to invoke — must be in PLANNER_TOOL_IDS */
  tool: PlanToolId;
  /** Human-readable reason for this step */
  purpose: string;
  /** Input payload passed to tool.execute() */
  input: Record<string, unknown>;
  /** Execution status */
  status: PlanStepStatus;
  /** Output from tool.execute() — only set when status is "completed" */
  output?: unknown;
  /** Error message — only set when status is "failed" */
  error?: string;
  /** ISO timestamp when step started */
  startedAt?: string;
  /** ISO timestamp when step completed */
  completedAt?: string;
};

// ── Planner diagnostics (always written to trace) ──

export type PlannerDiagnostics = {
  /** Why the planner was triggered */
  triggerReason: string;
  /** Which tools were selected for this plan */
  selectedTools: PlanToolId[];
  /** What context was missing that might have helped */
  missingContext: string[];
  /** Whether a fallback was used (step failure, validation failure, etc.) */
  fallbackUsed: boolean;
  /** Model used for plan generation (if LLM-based; undefined = rule-based) */
  model?: string;
};

// ── Plan ──

export type Plan = {
  /** Unique plan id (e.g. "plan_1712345678_abc123") */
  id: string;
  /** Human-readable explanation of what this plan aims to accomplish */
  reason: string;
  /** Always "planner" to distinguish from handler mode */
  mode: "planner";
  /** Maximum allowed steps (enforced by validatePlan) */
  maxSteps: number;
  /** Ordered steps to execute */
  steps: PlanStep[];
  /** Final answer composed after all steps complete (or via fallback) */
  finalAnswer?: string;
  /** Diagnostics for trace/debug */
  diagnostics: PlannerDiagnostics;
};

// ── Planner context (passed to tool execute()) ──

export type PlannerContext = {
  intentResult: IntentResult;
  intentContext: IntentContext;
  memorySnapshot?: MemorySnapshot;
  request: BeerDialogRequest;
  traceId: string;
};

// ── Tool definition ──

export type ToolDef = {
  id: PlanToolId;
  description: string;
  enabled: boolean;
  timeoutMs: number;
  /** Validate input before execution. Returns true if valid. */
  validate: (input: Record<string, unknown>) => boolean;
  /** Execute the tool. Input is already validated. */
  execute: (
    input: Record<string, unknown>,
    context: PlannerContext,
  ) => Promise<unknown>;
};

// ── Planner result (returned from runner) ──

export type PlannerResult = {
  /** The executed plan (steps populated with output/error/timestamps) */
  plan: Plan;
  /** Whether all steps completed without failure */
  success: boolean;
  /** Whether fallback was used */
  fallback: boolean;
  /** The final reply text */
  finalReply: string;
  /** Candidates extracted from score_recommendations output (if any) */
  candidates: BeerCandidate[];
  /** Picks extracted from score_recommendations output (if any) */
  picks: AgentResponse["picks"];
  /** Profile summary extracted from retrieve_memory output (if any) */
  profileSummary: string;
};

// ── Planner decision (from shouldUsePlanner) ──

export type PlannerDecision = {
  usePlanner: boolean;
  reason: string;
};

// ── Config types ──

export type PlannerConfig = {
  enabled: boolean;
  maxSteps: number;
  defaultMaxSteps: number;
  llmGenerationEnabled: boolean;
};

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  enabled: true,
  maxSteps: 6,
  defaultMaxSteps: 4,
  llmGenerationEnabled: false,
};
