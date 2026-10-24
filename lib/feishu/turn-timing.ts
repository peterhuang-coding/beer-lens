import { performance } from "node:perf_hooks";

/**
 * P0 单轮计时（飞书入口 → 队列 → 处理 → 完整回复 resolve）。
 *
 * 仅用单调时钟（performance.now，毫秒），绝对值也是单调读数而非 epoch；
 * 不记录任何 chat/user/message ID、正文、图片或提供方错误。
 * 每个入队消息持有一个独立实例，不使用任何全局“当前轮次”可变状态。
 */

export type FeishuTimingMessageType = "text" | "image" | "post" | "other";
export type FeishuTimingResult = "ok" | "processing_error" | "reply_error" | "duplicate";
export type FeishuTurnSpanKey = "imageDownloadMs" | "agentMs" | "memoryWriteMs";

export type FeishuTurnTimingRecord = {
  kind: "feishu_turn_timing";
  version: 1;
  clock: "monotonic";
  messageType: FeishuTimingMessageType;
  result: FeishuTimingResult;
  receivedAtMs: number;
  startedAtMs: number;
  finishedAtMs: number;
  queueWaitMs: number;
  processingMs: number;
  replyMs: number | null;
  firstReplyLatencyMs: number | null;
  replySucceeded: boolean;
} & Partial<Record<FeishuTurnSpanKey, number>>;

const TIMING_LOG_PREFIX = "[feishu:turn_timing]";
const KNOWN_MESSAGE_TYPES = new Set(["text", "image", "post"]);

export function normalizeFeishuMessageType(messageType: string): FeishuTimingMessageType {
  return KNOWN_MESSAGE_TYPES.has(messageType)
    ? (messageType as FeishuTimingMessageType)
    : "other";
}

export function createTurnTiming(messageType: string): TurnTiming {
  return new TurnTiming(normalizeFeishuMessageType(messageType), () => performance.now());
}

export class TurnTiming {
  private readonly messageType: FeishuTimingMessageType;
  private readonly now: () => number;
  private readonly receivedAtMs: number;
  private startedAtMs: number | null = null;
  private finishedAtMs: number | null = null;
  private firstReplyAttemptAtMs: number | null = null;
  private replySuccessCount = 0;
  private replyFailureSeenFlag = false;
  private duplicateFlag = false;
  private turnError: Exclude<FeishuTimingResult, "ok" | "duplicate"> | null = null;
  private readonly spans = new Map<FeishuTurnSpanKey, number>();
  private finished = false;

  constructor(messageType: FeishuTimingMessageType, now: () => number) {
    this.messageType = messageType;
    this.now = now;
    this.receivedAtMs = now();
  }

  /** 出队、回调真正开始时调用。 */
  markStarted(): void {
    if (this.startedAtMs === null) this.startedAtMs = this.now();
  }

  markReplyAttempt(): void {
    if (this.firstReplyAttemptAtMs === null) this.firstReplyAttemptAtMs = this.now();
  }

  markReplySuccess(): void {
    this.replySuccessCount += 1;
  }

  markReplyFailure(): void {
    this.replyFailureSeenFlag = true;
  }

  /** 处理函数转义到外层 catch 的瞬间，最近一次失败是否来自回发调用。 */
  replyFailureSeen(): boolean {
    return this.replyFailureSeenFlag;
  }

  markTurnFailed(kind: Exclude<FeishuTimingResult, "ok" | "duplicate">): void {
    if (this.turnError === null) this.turnError = kind;
  }

  markDuplicate(): void {
    this.duplicateFlag = true;
  }

  /** 可选阶段耗时；计时本身的异常由调用方保证不影响业务（纯读数）。 */
  async measure<T>(key: FeishuTurnSpanKey, fn: () => Promise<T>): Promise<T> {
    const begin = this.now();
    try {
      return await fn();
    } finally {
      this.spans.set(key, nonnegative(this.now() - begin));
    }
  }

  /** 落一条结构化记录；幂等。sink 失败不得影响消息结果。 */
  finish(): FeishuTurnTimingRecord | null {
    if (this.finished) return null;
    this.finished = true;
    const record = this.build();
    try {
      console.info(TIMING_LOG_PREFIX, JSON.stringify(record));
    } catch {
      // 计时日志失败对业务透明。
    }
    return record;
  }

  private build(): FeishuTurnTimingRecord {
    const receivedAt = this.receivedAtMs;
    const startedAt = this.startedAtMs ?? receivedAt;
    const finishedAt = this.now();
    this.finishedAtMs = finishedAt;

    const queueWaitMs = nonnegative(startedAt - receivedAt);
    const processingEndAt = this.firstReplyAttemptAtMs ?? finishedAt;
    const processingMs = nonnegative(processingEndAt - startedAt);
    const replyMs =
      this.firstReplyAttemptAtMs === null
        ? null
        : nonnegative(finishedAt - this.firstReplyAttemptAtMs);
    const replySucceeded = this.replySuccessCount > 0;

    let result: FeishuTimingResult;
    if (this.duplicateFlag) {
      result = "duplicate";
    } else if (this.turnError !== null) {
      result = this.turnError;
    } else {
      // 正常路径必有一次成功回发；无标记又无回复属于兜底的处理失败。
      result = replySucceeded ? "ok" : "processing_error";
    }

    const record: FeishuTurnTimingRecord = {
      kind: "feishu_turn_timing",
      version: 1,
      clock: "monotonic",
      messageType: this.messageType,
      result,
      receivedAtMs: receivedAt,
      startedAtMs: startedAt,
      finishedAtMs: finishedAt,
      queueWaitMs,
      processingMs,
      replyMs,
      // 兜底错误文案即使发送成功，result 仍是 *_error，不计入 SLO 成功。
      firstReplyLatencyMs: replySucceeded ? nonnegative(finishedAt - receivedAt) : null,
      replySucceeded,
    };
    for (const [key, value] of this.spans) {
      record[key] = value;
    }
    return record;
  }
}

function nonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
