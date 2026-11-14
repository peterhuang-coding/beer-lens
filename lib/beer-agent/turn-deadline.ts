export type TurnDeadline = {
  /** Wall-clock epoch milliseconds; queue wait consumes this same budget. */
  deadlineAtMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_FIRST_REPLY_BUDGET_MS = 60_000;
// Measured local knowledge + recommendation + short-term write is ~2.7s;
// 4s leaves room for conversation persistence and the Feishu send. The old
// 8s reserve canceled a real 51.7s DeepSeek vision response 12ms after the
// 52s agent deadline, discarding a complete HTTP 200 result.
const DEFAULT_REPLY_RESERVE_MS = 4_000;

function envDuration(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Reserve time for conversation persistence and the user-visible reply. */
export function firstReplyAgentBudgetMs(): number {
  const total = envDuration("BEER_FIRST_REPLY_BUDGET_MS", DEFAULT_FIRST_REPLY_BUDGET_MS);
  const reserve = envDuration("BEER_REPLY_RESERVE_MS", DEFAULT_REPLY_RESERVE_MS);
  return Math.max(1, total - reserve);
}

export function receiveAnchoredDeadlineAtMs(
  receivedAtMs = Date.now(),
  budgetMs = firstReplyAgentBudgetMs(),
): number {
  return receivedAtMs + budgetMs;
}

export class TurnDeadlineError extends Error {
  readonly code = "turn_deadline_exceeded";

  constructor() {
    super("本轮处理已超过时间预算");
    this.name = "TurnDeadlineError";
  }
}

export function isTurnDeadlineError(error: unknown): boolean {
  return error instanceof TurnDeadlineError ||
    (error as { code?: unknown } | null)?.code === "turn_deadline_exceeded";
}

export function throwIfTurnExpired(turn: TurnDeadline, nowMs = Date.now()): void {
  if (turn.signal?.aborted) {
    throw turn.signal.reason instanceof Error ? turn.signal.reason : new TurnDeadlineError();
  }
  if (turn.deadlineAtMs !== undefined && turn.deadlineAtMs <= nowMs) {
    throw new TurnDeadlineError();
  }
}

/**
 * Preserve an existing transport cap when no turn budget is supplied. With a
 * deadline, the next model call gets only the time left in this turn.
 */
export function turnModelOptions(
  turn: TurnDeadline,
  configuredTimeoutMs?: number,
  nowMs = Date.now(),
): { timeoutMs?: number; signal?: AbortSignal } {
  throwIfTurnExpired(turn, nowMs);
  const remaining = turn.deadlineAtMs === undefined
    ? undefined
    : turn.deadlineAtMs - nowMs;
  const timeoutMs = remaining === undefined
    ? configuredTimeoutMs
    : Math.min(configuredTimeoutMs ?? Number.POSITIVE_INFINITY, remaining);
  return {
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs)
      ? { timeoutMs: Math.floor(timeoutMs) }
      : {}),
    ...(turn.signal ? { signal: turn.signal } : {}),
  };
}

/** Create and clean up the timer for one agent turn, including parent aborts. */
export function createDeadlineSignal(
  deadlineAtMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new TurnDeadlineError());
  const remaining = deadlineAtMs - Date.now();
  let timer: NodeJS.Timeout | undefined;
  if (remaining <= 0) abort();
  else {
    timer = setTimeout(abort, remaining);
    timer.unref();
  }

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}
