/**
 * Planner Trace — extends the existing trace system with planner diagnostics.
 *
 * The existing writeTrace() in lib/beer-agent/trace.ts handles file I/O.
 * This module adds planner-specific data to TraceRecord before writing.
 */

import type { Plan, PlannerDiagnostics } from "./types";
import type { TraceRecord } from "@/lib/beer-agent/dialog-types";

/**
 * Attach planner trace data to a TraceRecord.
 * Should be called before writeTrace() in the orchestrator.
 */
export function attachPlannerTrace(
  traceRecord: TraceRecord,
  plan: Plan,
): void {
  traceRecord.planner = {
    plan: {
      id: plan.id,
      reason: plan.reason,
      mode: plan.mode,
      maxSteps: plan.maxSteps,
      steps: plan.steps.map((s) => ({
        id: s.id,
        tool: s.tool,
        purpose: s.purpose,
        status: s.status,
        input: s.input,
        output: s.output,
        error: s.error,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      })),
      finalAnswer: plan.finalAnswer,
    },
    diagnostics: {
      triggerReason: plan.diagnostics.triggerReason,
      selectedTools: plan.diagnostics.selectedTools,
      missingContext: plan.diagnostics.missingContext,
      fallbackUsed: plan.diagnostics.fallbackUsed,
      model: plan.diagnostics.model,
    },
  };
}
