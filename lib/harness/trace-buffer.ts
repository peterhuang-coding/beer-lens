/**
 * In-memory ring buffer of completed /api/chat runs.
 *
 * Stage 2 schema (post P1):
 *   - Each chat turn is a *tree* of TraceEntry rows. The root has
 *     `parent_ts === null` and `root_ts === ts`. Descendants carry the
 *     root's `root_ts` and their own `parent_ts` (the stage they sit under).
 *   - `stage` is a short, dotted identifier (e.g. "chat", "route:enter",
 *     "rule:eval", "rule:match", "rule:fire", "llm:call", "llm:classify",
 *     "skill:invoke", "memory:read", "memory:write", "route:error").
 *   - `decision` is an arbitrary small payload describing the decision
 *     made at that stage (truncated to MAX_DECISION_BYTES to keep buffer
 *     memory bounded).
 *
 * Storage: capped at MAX entries (default 500, override via TRACE_BUFFER_MAX);
 * oldest are evicted FIFO. Concurrency: single-threaded JS, no locks.
 *
 * Readers:
 *   - listTraceEntries(limit, options?)   — flat list, most-recent first.
 *     By default returns root entries only (parent_ts === null). Pass
 *     `{ includeAll: true }` to include descendants.
 *   - getTreeByRoot(root_ts)             — flat list of every entry with
 *     that root_ts, sorted by ts ascending. Caller assembles the tree via
 *     parent_ts.
 */

const MAX = Number(process.env.TRACE_BUFFER_MAX ?? 500);
const MAX_DECISION_BYTES = 4 * 1024;

export interface TraceEntry {
  /** Wall-clock ms since epoch. Set by appendStage(). */
  ts: number;
  /** ISO-8601 string for display. Set by appendStage(). */
  ts_iso: string;
  /** First 80 chars of the user message (ellipsised). Only on root. */
  message: string;
  /** Routed skill id, or "none" when routing fell through. Only on root. */
  skill_id: string;
  /** Whether the route came from keyword rule, LLM, or short-circuit. Only on root. */
  source: "rule" | "llm" | "none" | "error";
  /** false when an SSE error event was emitted. Only on root. */
  ok: boolean;
  /** Stable error code on failure. */
  error_code?: string;
  /** Total chat handler wall-time. Only on root. */
  latency_ms: number;
  /** Candidate count returned by the skill (0 for non-recommend skills). Only on root. */
  candidate_count: number;
  /** True when the request carried an image attachment. Only on root. */
  has_image: boolean;
  /** Router reason text (e.g. "keyword → menu_recommend"). */
  reason?: string;

  // ── Stage 2 additions ──────────────────────────────────────────────────
  /** The chat request this entry belongs to. Root entry has ts === root_ts. */
  root_ts: number;
  /** Parent stage's ts, or null for the root. */
  parent_ts: number | null;
  /** Stage identifier (see file header). */
  stage: string;
  /** This stage's own wall-clock duration. Root == latency_ms. */
  duration_ms: number;
  /** Bounded payload describing the decision made at this stage. */
  decision?: Record<string, unknown>;
  /** Skill that produced this entry (when relevant). */
  stage_skill_id?: string;
}

// Module-scoped state would be duplicated across the per-route bundles that
// Next.js webpack emits (each route gets its own module instance). Pin the
// buffer to globalThis so /api/chat's appendStage() lands in the same array
// /api/debug/recent reads via listTraceEntries().
type HarnessGlobals = typeof globalThis & {
  __harness_trace_buf__?: TraceEntry[];
};
const _globals = globalThis as HarnessGlobals;
const _buf: TraceEntry[] = _globals.__harness_trace_buf__ ?? (_globals.__harness_trace_buf__ = []);

function boundedDecision(d?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!d) return undefined;
  try {
    const json = JSON.stringify(d);
    if (json.length <= MAX_DECISION_BYTES) return d;
    // Truncate by stringifying first N chars; rebuild a small marker object.
    return { _truncated: true, preview: json.slice(0, MAX_DECISION_BYTES - 64) + "…" };
  } catch {
    return { _unserializable: true };
  }
}

function pushEntry(entry: TraceEntry): void {
  _buf.push(entry);
  if (_buf.length > MAX) _buf.shift();
}

/**
 * Legacy entry point — preserved so older callers still compile. Builds a
 * root entry with stage "chat" and parent_ts null. New code should call
 * appendStage() directly so root_ts is plumbed correctly.
 */
export function appendTrace(
  entry: Omit<TraceEntry, "ts" | "ts_iso" | "root_ts" | "parent_ts" | "stage" | "duration_ms" | "decision">,
): void {
  const now = Date.now();
  pushEntry({
    ...entry,
    ts: now,
    ts_iso: new Date(now).toISOString(),
    root_ts: now,
    parent_ts: null,
    stage: "chat",
    duration_ms: entry.latency_ms ?? 0,
    decision: boundedDecision({ ok: entry.ok, skill_id: entry.skill_id, source: entry.source }),
  });
}

/**
 * Stage 2 entry point. Adds a stage entry under root_ts. Returns the ts of
 * the new entry so callers can chain descendants via parent_ts.
 *
 * Pass `started_at` to record a stage's duration without re-measuring
 * (e.g. when the stage began before the caller reached this function).
 */
export function appendStage(
  root_ts: number,
  parent_ts: number | null,
  stage: string,
  partial: {
    message?: string;
    skill_id?: string;
    source?: "rule" | "llm" | "none" | "error";
    ok?: boolean;
    error_code?: string;
    latency_ms?: number;
    candidate_count?: number;
    has_image?: boolean;
    reason?: string;
    stage_skill_id?: string;
    decision?: Record<string, unknown>;
    /** When this stage began (default = Date.now()). */
    started_at?: number;
    /** Override the entry's own ts. Root entries set this to root_ts so that
     *  `ts === root_ts` for the root. Descendants leave it at Date.now(). */
    ts?: number;
    /** Override the entry's own duration. Computed from ts - started_at if omitted. */
    duration_ms?: number;
  } = {},
): number {
  const now = Date.now();
  const started_at = partial.started_at ?? now;
  const entry_ts = partial.ts ?? now;
  // Duration is anchored to "now" so that when a caller forces the root
  // entry's ts back to the request start (ts === root_ts === t0), the
  // duration still reflects how long the request actually took.
  const computed_duration = Math.max(0, Math.max(now, entry_ts) - started_at);
  const finalDuration = partial.duration_ms ?? computed_duration;
  pushEntry({
    ts: entry_ts,
    ts_iso: new Date(entry_ts).toISOString(),
    message: partial.message ?? "",
    skill_id: partial.skill_id ?? "",
    source: partial.source ?? "none",
    ok: partial.ok ?? true,
    error_code: partial.error_code,
    latency_ms: partial.latency_ms ?? finalDuration,
    candidate_count: partial.candidate_count ?? 0,
    has_image: partial.has_image ?? false,
    reason: partial.reason,
    root_ts,
    parent_ts,
    stage,
    duration_ms: finalDuration,
    decision: boundedDecision(partial.decision),
    stage_skill_id: partial.stage_skill_id,
  });
  return now;
}

export interface ListOptions {
  /** When true, include non-root descendants in the result. Default false (root only). */
  includeAll?: boolean;
}

export function listTraceEntries(limit = 50, options: ListOptions = {}): TraceEntry[] {
  const n = Math.max(1, Math.min(MAX, limit));
  const slice = _buf.slice(-n);
  const result = options.includeAll ? slice : slice.filter((e) => e.parent_ts === null);
  return result.reverse();
}

export function getTreeByRoot(root_ts: number): TraceEntry[] {
  return _buf
    .filter((e) => e.root_ts === root_ts)
    .sort((a, b) => a.ts - b.ts);
}

export function clearTraceEntries(): void {
  _buf.length = 0;
}

/** Test helper — current entry count (not exported via API). */
export function _traceBufferSize(): number {
  return _buf.length;
}

/** Test helper — current max capacity. */
export function _traceBufferMax(): number {
  return MAX;
}

/** Truncate a user message for display in Recent view. */
export function previewMessage(msg: string, max = 80): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + "…";
}