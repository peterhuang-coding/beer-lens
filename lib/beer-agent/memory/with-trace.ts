/**
 * Trace helpers for memory module hooks.
 *
 * All 4 instrumented memory files (`short-term`, `episodic`, `profile`,
 * `corrections`) import these helpers. They read the active trace
 * context from AsyncLocalStorage so the caller doesn't have to thread
 * `root_ts` / `parent_ts` through every signature. When no trace is
 * active (tests, CLI scripts), the helpers are silent no-ops.
 *
 * Each helper is wrapped in try/catch so a trace write can never break
 * the memory operation itself.
 */

import { appendStage } from "../../harness/trace-buffer.ts";
import { getTraceCtx } from "../../harness/trace-context.ts";

function safeAppend(
  stage: string,
  partial: {
    decision: Record<string, unknown>;
    ok?: boolean;
    duration_ms?: number;
  },
  started_at: number,
): void {
  const ctx = getTraceCtx();
  if (!ctx) return;
  try {
    appendStage(ctx.root_ts, ctx.parent_ts, stage, {
      ok: partial.ok ?? true,
      duration_ms: partial.duration_ms ?? Math.max(0, Date.now() - started_at),
      decision: partial.decision,
      started_at,
    });
  } catch {
    /* never let tracing kill memory I/O */
  }
}

export function traceMemoryRead(decision: Record<string, unknown>): void {
  safeAppend("memory:read", { decision }, Date.now());
}

export function traceMemoryWrite(
  decision: Record<string, unknown>,
  ok = true,
): void {
  safeAppend("memory:write", { decision, ok }, Date.now());
}
