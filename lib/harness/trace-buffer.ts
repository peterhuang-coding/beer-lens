/**
 * In-memory ring buffer of completed /api/chat runs.
 *
 * The chat route appends a TraceEntry on every SSE completion (success,
 * fallback, or error). The new /debug "Recent" view reads from this buffer
 * via /api/debug/recent. The buffer is module-scoped so chat and the read
 * API share state in the same Node process.
 *
 * Storage: capped at MAX entries; oldest are evicted FIFO.
 * Persistence: none. Dev hot-reload and process restarts wipe the buffer —
 * acceptable for a debug-only view.
 *
 * Concurrency: single-threaded JS, no locks needed. `append` is sync.
 */

const MAX = 100;

export interface TraceEntry {
  /** Wall-clock ms since epoch. */
  ts: number;
  /** ISO-8601 string for display. */
  ts_iso: string;
  /** First 80 chars of the user message (ellipsised). */
  message: string;
  /** Routed skill id, or "none" when routing fell through. */
  skill_id: string;
  /** Whether the route came from keyword rule, LLM, or short-circuit. */
  source: "rule" | "llm" | "none" | "error";
  /** false when an SSE error event was emitted. */
  ok: boolean;
  /** Stable error code on failure. */
  error_code?: string;
  /** Total chat handler wall-time. */
  latency_ms: number;
  /** Candidate count returned by the skill (0 for non-recommend skills). */
  candidate_count: number;
  /** True when the request carried an image attachment. */
  has_image: boolean;
  /** Router reason text (e.g. "keyword → menu_recommend"). */
  reason?: string;
}

const _buf: TraceEntry[] = [];

export function appendTrace(entry: TraceEntry): void {
  _buf.push(entry);
  if (_buf.length > MAX) _buf.shift();
}

export function listTraceEntries(limit = 50): TraceEntry[] {
  // Return most-recent first; clamp the limit to [1, MAX].
  const n = Math.max(1, Math.min(MAX, limit));
  return _buf.slice(-n).reverse();
}

export function clearTraceEntries(): void {
  _buf.length = 0;
}

/** Test helper — current entry count (not exported via API). */
export function _traceBufferSize(): number {
  return _buf.length;
}

/** Truncate a user message for display in Recent view. */
export function previewMessage(msg: string, max = 80): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + "…";
}