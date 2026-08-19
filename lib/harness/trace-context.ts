/**
 * AsyncLocalStorage-based trace context.
 *
 * The chat route captures `root_ts` and `parent_ts` at request entry and
 * runs the entire handler inside `runWithTrace(...)`. Any code that needs
 * to write a stage entry to the trace buffer calls `getTraceCtx()` and uses
 * the returned `{root_ts, parent_ts}` — no explicit threading required.
 *
 * If `getTraceCtx()` returns undefined (e.g. a CLI script, a test, or a
 * pre-ALS code path), hook code must no-op. ALS is a Node built-in
 * (>= 14) and is stable across `await` boundaries and Web Streams.
 *
 * Each "stage" in the trace tree is identified by the call site's ts;
 * parent_ts defaults to root_ts when the caller hasn't begun a sub-stage
 * (i.e. it's the first stage under the chat request).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SkillId } from "./types";

export interface TraceCtx {
  /** Wall-clock ms of the chat request that owns this trace tree. */
  root_ts: number;
  /** ts of the immediate parent stage, or null if the caller IS the root. */
  parent_ts: number | null;
  /** The skill id chosen by routing (once known). Useful for rule engines. */
  skill_id?: SkillId;
}

// Pin the ALS instance to globalThis so module instances split by webpack
// (e.g. static import vs. dynamic `await import()`) share the same store.
type HarnessGlobals = typeof globalThis & {
  __harness_trace_als__?: AsyncLocalStorage<TraceCtx>;
};
const _globals = globalThis as HarnessGlobals;
const _als: AsyncLocalStorage<TraceCtx> =
  _globals.__harness_trace_als__ ?? (_globals.__harness_trace_als__ = new AsyncLocalStorage<TraceCtx>());

export function getTraceCtx(): TraceCtx | undefined {
  return _als.getStore();
}

export function runWithTrace<T>(ctx: TraceCtx, fn: () => T): T {
  return _als.run(ctx, fn);
}

/** Convenience: enter a sub-stage under the current root. */
export function withChildStage<T>(
  parent_ts: number,
  patch: Partial<TraceCtx>,
  fn: () => T,
): T {
  const cur = _als.getStore();
  if (!cur) return fn();
  return _als.run({ ...cur, parent_ts, ...patch }, fn);
}