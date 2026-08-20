/**
 * Rule engine — single entry point for running hard rules at a stage.
 *
 * Usage from a hook site:
 *   const outcome = runRulesForStage("pre-route", { message, skill_id, source });
 *   if (outcome.action?.kind === "route_override") { ... }
 *   if (outcome.action?.kind === "block") return error(...)
 *   for (const a of outcome.annotations) { ... }
 *
 * Each rule fires → appendStage("rule:fire", { decision: { rule_id,
 * action_kind, applied } }) is emitted so the trace tree shows the rule
 * firing. Stats derive rule hit counts from the `rule:fire` stage.
 *
 * Block short-circuits — once any rule blocks, lower-priority rules are
 * skipped. The block reason is captured on the *first* blocking rule's
 * stage entry.
 *
 * The engine is safe to call with no trace context: every trace side
 * effect is wrapped in try/catch.
 */

import { appendStage } from "./trace-buffer.ts";
import { listRules, type Stage, type RuleAction, type RuleCtx } from "./rules.ts";

export interface RuleOutcome {
  /** The first action with the highest priority that fired. */
  action: RuleAction | null;
  /** All annotations emitted by rules in this run (key → value). */
  annotations: Record<string, unknown>;
  /** All log entries emitted by rules in this run. */
  logs: Array<{ level: "info" | "warn"; message: string }>;
  /** Rule ids that fired (any action). */
  firedRuleIds: string[];
  /** Last transform_reply that fired (post-skill only). Empty otherwise. */
  transformedReply: string | null;
  /** First retry_llm_with_hint that fired (pre-llm only). Null otherwise. */
  retryHint: { hint: string; max_attempts?: number } | null;
}

export function runRulesForStage(
  stage: Stage,
  ctx: RuleCtx,
  traceCtx?: { root_ts: number; parent_ts: number | null },
): RuleOutcome {
  const outcome: RuleOutcome = {
    action: null,
    annotations: {},
    logs: [],
    firedRuleIds: [],
    transformedReply: null,
    retryHint: null,
  };

  // Sort by priority desc; ties keep insertion order (stable sort).
  const applicable = listRules()
    .filter((r) => r.stage === stage && r.enabled)
    .slice()
    .sort((a, b) => b.priority - a.priority);

  for (const rule of applicable) {
    let action: RuleAction | null = null;
    try {
      action = rule.evaluate(ctx);
    } catch {
      // A misbehaving rule must never break the harness — record and skip.
      try {
        if (traceCtx) {
          appendStage(traceCtx.root_ts, traceCtx.parent_ts, "rule:fire", {
            decision: { rule_id: rule.id, action_kind: "error", applied: false },
          });
        }
      } catch { /* ignore */ }
      continue;
    }
    if (!action) continue;

    outcome.firedRuleIds.push(rule.id);

    // Annotations accumulate; transform_reply keeps the LAST one (so a
    // lower-priority rule can't be silently overridden by an earlier
    // higher-priority one without trace); other actions short-circuit.
    if (action.kind === "annotate") {
      outcome.annotations[action.key] = action.value;
    } else if (action.kind === "log") {
      outcome.logs.push({ level: action.level, message: action.message });
    } else if (action.kind === "transform_reply") {
      outcome.transformedReply = action.new_reply;
    } else if (action.kind === "retry_llm_with_hint") {
      if (!outcome.retryHint) {
        outcome.retryHint = { hint: action.hint, max_attempts: action.max_attempts };
      }
    } else if (!outcome.action) {
      // route_override / filter_candidates / block — first one wins.
      outcome.action = action;
    }

    // Trace the fire.
    if (traceCtx) {
      try {
        appendStage(traceCtx.root_ts, traceCtx.parent_ts, "rule:fire", {
          decision: {
            rule_id: rule.id,
            stage,
            action_kind: action.kind,
            applied: true,
            ...(action.kind === "annotate" ? { key: action.key, value: action.value } : {}),
            ...(action.kind === "block" ? { reason: action.reason } : {}),
            ...(action.kind === "route_override" ? { skill_id: action.skill_id } : {}),
            ...(action.kind === "log" ? { level: action.level } : {}),
            ...(action.kind === "filter_candidates" ? { predicate: action.predicate } : {}),
            ...(action.kind === "transform_reply" ? { reason: action.reason } : {}),
            ...(action.kind === "retry_llm_with_hint"
              ? { hint: action.hint, max_attempts: action.max_attempts ?? 1 }
              : {}),
          },
        });
      } catch { /* never let tracing kill the harness */ }
    }

    // Block short-circuits.
    if (action.kind === "block") break;
  }

  return outcome;
}
