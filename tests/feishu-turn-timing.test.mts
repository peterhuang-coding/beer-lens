import assert from "node:assert/strict";
import { after, test } from "node:test";

// SELF-LOAD the synthetic facade loader BEFORE the handler module graph is
// evaluated. A static `import` of handler.ts would resolve its dependencies
// too early (the final test command deliberately does not preload a loader),
// so hooks are registered here first and handler.ts is imported dynamically.
await import(new URL("./fixtures/feishu-handler-stubs.mjs", import.meta.url));

type Stubs = Record<string, (...args: any[]) => any>;
type IncomingMessage = {
  text: string;
  imageKey: string;
  fileKey: string;
  messageId: string;
  chatId: string;
  messageType: string;
};

const TIMING_PREFIX = "[feishu:turn_timing]";

function defaultStubs(): Stubs {
  return {
    runAgentTurn: async () => ({ reply: "synthetic answer" }),
    handleMbcbQuery: async () => null,
    downloadFeishuImage: async () => ({ type: "image/png", dataUrl: "data:image/png;base64,U1lOVEg=" }),
    replyFeishuMessage: async () => {},
    beginConversationTurn: async () => true,
    clearConversation: async () => {},
    completeConversationTurn: async () => {},
    getConversationMessages: async () => [],
    clearShortTermMemory: async () => {},
    listCases: async () => [],
    updateCase: async () => {},
  };
}

(globalThis as any).__beerFeishuStub = defaultStubs();
const handler = await import("../lib/feishu/handler.ts");
const { enqueueFeishuMessage, drainFeishuMessages } = handler as {
  enqueueFeishuMessage: (message: IncomingMessage) => Promise<void>;
  drainFeishuMessages: () => Promise<void>;
};

function install(overrides: Stubs = {}): Stubs {
  const stubs = { ...defaultStubs(), ...overrides };
  (globalThis as any).__beerFeishuStub = stubs;
  return stubs;
}

function makeMessage(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    text: "",
    imageKey: "",
    fileKey: "",
    messageId: "message-1",
    chatId: "chat-1",
    messageType: "text",
    ...partial,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const records: any[] = [];
const realConsoleInfo = console.info;
console.info = (...args: unknown[]) => {
  if (args[0] === TIMING_PREFIX) {
    records.push(JSON.parse(String(args[1])));
  }
};
after(() => {
  console.info = realConsoleInfo;
});

function assertNonNegFinite(value: unknown, label: string): void {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(value as number >= 0, `${label} must be nonnegative`);
}

function assertValidRecord(record: any, expectedType: string): void {
  assert.equal(record.kind, "feishu_turn_timing");
  assert.equal(record.version, 1);
  assert.equal(record.clock, "monotonic");
  assert.equal(record.messageType, expectedType);
  assert.ok(["ok", "processing_error", "reply_error", "duplicate"].includes(record.result));
  assert.equal(typeof record.replySucceeded, "boolean");

  assertNonNegFinite(record.receivedAtMs, "receivedAtMs");
  assertNonNegFinite(record.startedAtMs, "startedAtMs");
  assertNonNegFinite(record.finishedAtMs, "finishedAtMs");
  assert.ok(record.receivedAtMs <= record.startedAtMs + 0.001, "recv before start");
  assert.ok(record.startedAtMs <= record.finishedAtMs + 0.001, "start before finish");

  assertNonNegFinite(record.queueWaitMs, "queueWaitMs");
  assertNonNegFinite(record.processingMs, "processingMs");
  assert.ok(Math.abs(record.queueWaitMs - (record.startedAtMs - record.receivedAtMs)) < 0.01);
  if (record.replyMs === null) {
    assert.equal(record.firstReplyLatencyMs, null);
    assert.equal(record.replySucceeded, false);
  } else {
    assertNonNegFinite(record.replyMs, "replyMs");
  }
  if (record.replySucceeded) {
    assertNonNegFinite(record.firstReplyLatencyMs, "firstReplyLatencyMs");
    assert.ok(
      Math.abs(record.firstReplyLatencyMs - (record.finishedAtMs - record.receivedAtMs)) < 0.01,
      "firstReplyLatencyMs spans recv to finish",
    );
  } else {
    assert.equal(record.firstReplyLatencyMs, null);
  }
  for (const span of ["imageDownloadMs", "agentMs", "memoryWriteMs"]) {
    if (record[span] !== undefined) assertNonNegFinite(record[span], span);
  }
}

const BASE_RECORD_KEYS = [
  "kind",
  "version",
  "clock",
  "messageType",
  "result",
  "receivedAtMs",
  "startedAtMs",
  "finishedAtMs",
  "queueWaitMs",
  "processingMs",
  "replyMs",
  "firstReplyLatencyMs",
  "replySucceeded",
];
const SPAN_KEYS = ["imageDownloadMs", "agentMs", "memoryWriteMs"];

function assertRedacted(record: any, secrets: string[]): void {
  const json = JSON.stringify(record);
  for (const secret of secrets) {
    assert.ok(!json.includes(secret), `timing record must not leak ${secret}`);
  }
  const keys = Object.keys(record);
  for (const key of BASE_RECORD_KEYS) {
    assert.ok(keys.includes(key), `record must include ${key}`);
  }
  const allowed = new Set([...BASE_RECORD_KEYS, ...SPAN_KEYS]);
  for (const key of keys) {
    assert.ok(allowed.has(key), `record must not carry undeclared field ${key}`);
  }
}

test("ok text turn: one record after deferred reply resolves, queue-to-first-reply latency includes the hold", async () => {
  records.length = 0;
  const replies: Array<[string, string]> = [];
  let replyReleased = false;
  const gate = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  })();
  install({
    replyFeishuMessage: async (id: string, text: string) => {
      replies.push([id, text]);
      await gate.promise;
      replyReleased = true;
    },
  });

  const done = enqueueFeishuMessage(
    makeMessage({ messageId: "m-ok", chatId: "chat-ok", text: "sensitive question" }),
  );
  await sleep(30);
  assert.equal(records.length, 0, "no record before reply settles");
  assert.equal(replyReleased, false);
  gate.resolve();
  await done;
  await drainFeishuMessages();

  assert.equal(replies.length, 1);
  assert.equal(replies[0][1], "synthetic answer");
  assert.equal(records.length, 1);
  const record = records[0];
  assertValidRecord(record, "text");
  assert.equal(record.result, "ok");
  assert.equal(record.replySucceeded, true);
  assert.ok(record.replyMs >= 25, `replyMs must cover the deferred hold, got ${record.replyMs}`);
  assert.ok(record.firstReplyLatencyMs >= record.replyMs);
  assert.ok(record.agentMs !== undefined);
  assertRedacted(record, ["m-ok", "chat-ok", "sensitive question", "synthetic answer"]);
});

test("same chat: second message waits behind the first in-flight turn and that wait is in its latency", async () => {
  records.length = 0;
  install({
    replyFeishuMessage: async (id: string) => {
      if (id === "qa") await sleep(40);
    },
  });

  const first = enqueueFeishuMessage(makeMessage({ messageId: "qa", chatId: "chat-serial", text: "A" }));
  const second = enqueueFeishuMessage(makeMessage({ messageId: "qb", chatId: "chat-serial", text: "B" }));
  await Promise.all([first, second]);
  await drainFeishuMessages();

  assert.equal(records.length, 2);
  const [a, b] = records;
  assertValidRecord(a, "text");
  assertValidRecord(b, "text");
  assert.ok(a.queueWaitMs < 15, `first message starts immediately, got ${a.queueWaitMs}`);
  assert.ok(b.queueWaitMs >= 25, `queued message waits for the prior turn, got ${b.queueWaitMs}`);
  assert.ok(b.startedAtMs >= a.finishedAtMs - 2, "second turn starts only after first settled");
  assert.ok(b.firstReplyLatencyMs >= b.queueWaitMs, "end-to-end latency includes queue wait");
  assert.ok(b.replyMs >= 0);
});

test("different chats run concurrently: neither turn waits behind the other", async () => {
  records.length = 0;
  install({
    replyFeishuMessage: async (id: string) => {
      if (id === "x1" || id === "y1") await sleep(40);
    },
  });

  const x = enqueueFeishuMessage(makeMessage({ messageId: "x1", chatId: "chat-x", text: "X" }));
  const y = enqueueFeishuMessage(makeMessage({ messageId: "y1", chatId: "chat-y", text: "Y" }));
  await Promise.all([x, y]);
  await drainFeishuMessages();

  assert.equal(records.length, 2);
  const [a, b] = records;
  assertValidRecord(a, "text");
  assertValidRecord(b, "text");
  assert.ok(Math.abs(a.startedAtMs - b.startedAtMs) < 15, "both chats start together");
  assert.ok(a.queueWaitMs < 15 && b.queueWaitMs < 15, "no cross-chat queueing");
  assert.ok(a.firstReplyLatencyMs < 70 && b.firstReplyLatencyMs < 70, "turns overlap instead of stacking");
  assert.ok(a.replyMs >= 30 && b.replyMs >= 30, "each reply span measured independently");
});

test("reset route resets state, replies once and is ok without running the agent", async () => {
  records.length = 0;
  const calls = { clear: 0, stm: 0, agent: 0, replies: 0 };
  install({
    clearConversation: async () => {
      calls.clear++;
    },
    clearShortTermMemory: async () => {
      calls.stm++;
    },
    runAgentTurn: async () => {
      calls.agent++;
      return { reply: "should not happen" };
    },
    replyFeishuMessage: async () => {
      calls.replies++;
    },
  });

  await enqueueFeishuMessage(
    makeMessage({ messageId: "m-reset", chatId: "chat-reset", text: "/reset", messageType: "text" }),
  );
  await drainFeishuMessages();

  assert.equal(calls.clear, 1);
  assert.equal(calls.stm, 1);
  assert.equal(calls.agent, 0);
  assert.equal(calls.replies, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].result, "ok");
  assert.equal(records[0].agentMs, undefined);
  assertValidRecord(records[0], "text");
});

test("catalog route serves the catalog reply and stays ok without the agent", async () => {
  records.length = 0;
  const replies: string[] = [];
  let agentCalls = 0;
  install({
    handleMbcbQuery: async () => "CATALOG_BODY",
    runAgentTurn: async () => {
      agentCalls++;
      return { reply: "nope" };
    },
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-cat", chatId: "chat-cat", text: "目录" }));
  await drainFeishuMessages();

  assert.deepEqual(replies, ["CATALOG_BODY"]);
  assert.equal(agentCalls, 0);
  assert.equal(records[0].result, "ok");
  assertValidRecord(records[0], "text");
});

test("case-label route resolves through the dynamic cases facade and stays ok", async () => {
  records.length = 0;
  const replies: string[] = [];
  install({
    listCases: async () => [],
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });
  await enqueueFeishuMessage(makeMessage({ messageId: "m-label", chatId: "chat-label", text: "good" }));
  await drainFeishuMessages();
  assert.match(replies[0], /没找到上一轮对话记录/);
  assert.equal(records[0].result, "ok");
  assertValidRecord(records[0], "text");
});

test("duplicate turn is recorded as duplicate: no reply, null latency, no SLO success", async () => {
  records.length = 0;
  let replyCalls = 0;
  install({
    beginConversationTurn: async () => false,
    replyFeishuMessage: async () => {
      replyCalls++;
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-dup", chatId: "chat-dup", text: "again" }));
  await drainFeishuMessages();

  assert.equal(replyCalls, 0);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.result, "duplicate");
  assert.equal(record.replySucceeded, false);
  assert.equal(record.replyMs, null);
  assert.equal(record.firstReplyLatencyMs, null);
  assertNonNegFinite(record.queueWaitMs, "queueWaitMs");
  assertNonNegFinite(record.processingMs, "processingMs");
  assertRedacted(record, ["m-dup", "chat-dup", "again"]);
});

test("processing failure sends the fallback reply but keeps processing_error and never counts SLO success", async () => {
  records.length = 0;
  const replies: string[] = [];
  install({
    completeConversationTurn: async () => {
      throw new Error("db down secret-token-PROC");
    },
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-proc", chatId: "chat-proc", text: "hi" }));
  await drainFeishuMessages();

  assert.match(replies[0], /暂时无法处理这条消息/);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.result, "processing_error");
  assert.equal(record.replySucceeded, true, "fallback text was delivered");
  assertNonNegFinite(record.firstReplyLatencyMs, "firstReplyLatencyMs");
  assert.notEqual(record.result, "ok", "error fallback is not a successful SLO");
  assertRedacted(record, ["db down", "secret-token-PROC", "m-proc", "chat-proc"]);
});

test("processing failure plus failed fallback stays processing_error with null latency and does not throw", async () => {
  records.length = 0;
  install({
    completeConversationTurn: async () => {
      throw new Error("db down secret-token-PROC2");
    },
    replyFeishuMessage: async () => {
      throw new Error("Feishu reply failed secret-token-FB");
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-proc2", chatId: "chat-proc2", text: "hi" }));
  await drainFeishuMessages();

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.result, "processing_error");
  assert.equal(record.replySucceeded, false);
  assert.equal(record.firstReplyLatencyMs, null);
  assertRedacted(record, ["secret-token-PROC2", "secret-token-FB"]);
});

test("inner agent failure is processing_error: existing error text delivered once, conversation failed, never SLO ok", async () => {
  records.length = 0;
  const replies: string[] = [];
  const statuses: string[] = [];
  install({
    runAgentTurn: async () => {
      throw new Error("provider failure secret-token-AGENT");
    },
    completeConversationTurn: async (_c: string, _m: string, _a: unknown, status: string) => {
      statuses.push(status);
    },
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-agent", chatId: "chat-agent", text: "hi" }));
  await drainFeishuMessages();

  assert.equal(replies.length, 1);
  assert.match(replies[0], /处理出错了/);
  assert.deepEqual(statuses, ["failed"]);
  const record = records[0];
  assert.equal(record.result, "processing_error");
  assert.equal(record.replySucceeded, true, "error fallback text was delivered but is not SLO success");
  assertNonNegFinite(record.firstReplyLatencyMs, "firstReplyLatencyMs");
  assertRedacted(record, ["secret-token-AGENT", "m-agent", "chat-agent"]);
});

test("image download failure is processing_error: fallback delivered once, conversation failed, spans retained", async () => {
  records.length = 0;
  const replies: string[] = [];
  const statuses: string[] = [];
  install({
    downloadFeishuImage: async () => {
      throw new Error("image fetch failed secret-token-IMG");
    },
    completeConversationTurn: async (_c: string, _m: string, _a: unknown, status: string) => {
      statuses.push(status);
    },
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });

  await enqueueFeishuMessage(
    makeMessage({ messageId: "m-imgfail", chatId: "chat-imgfail", messageType: "image", imageKey: "img-fail-key" }),
  );
  await drainFeishuMessages();

  assert.equal(replies.length, 1);
  assert.match(replies[0], /处理出错了/);
  assert.deepEqual(statuses, ["failed"]);
  const record = records[0];
  assertValidRecord(record, "image");
  assert.equal(record.result, "processing_error");
  assert.equal(record.replySucceeded, true);
  assertNonNegFinite(record.imageDownloadMs, "imageDownloadMs");
  assert.equal(record.agentMs, undefined, "agent never runs after image download fails");
  assertRedacted(record, ["secret-token-IMG", "img-fail-key", "m-imgfail", "chat-imgfail"]);
});

test("technical agent warning is processing_error: the real reply is delivered once but the conversation is failed", async () => {
  records.length = 0;
  const replies: string[] = [];
  const statuses: string[] = [];
  install({
    runAgentTurn: async () => ({
      reply: "synthetic answer with degraded data",
      debug: { warnings: ["pipeline degraded secret-token-WARN"] },
    }),
    completeConversationTurn: async (_c: string, _m: string, _a: unknown, status: string) => {
      statuses.push(status);
    },
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-warn", chatId: "chat-warn", text: "hi" }));
  await drainFeishuMessages();

  assert.deepEqual(replies, ["synthetic answer with degraded data"]);
  assert.deepEqual(statuses, ["failed"]);
  const record = records[0];
  assertValidRecord(record, "text");
  assert.equal(record.result, "processing_error");
  assert.equal(record.replySucceeded, true, "degraded reply delivered but technical warning is not SLO ok");
  assertRedacted(record, ["secret-token-WARN", "m-warn", "chat-warn"]);
});

test("normal sparse informative answer without technical warning stays ok even when it notes unknown or missing hops", async () => {
  records.length = 0;
  const sparseReply = "款级酒花资料 unknown / hops missing，暂未核实，可先按风格了解";
  const replies: string[] = [];
  const statuses: string[] = [];
  install({
    runAgentTurn: async () => ({ reply: sparseReply }),
    completeConversationTurn: async (_c: string, _m: string, _a: unknown, status: string) => {
      statuses.push(status);
    },
    replyFeishuMessage: async (_id: string, text: string) => {
      replies.push(text);
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-sparse", chatId: "chat-sparse", text: "这款酒如何" }));
  await drainFeishuMessages();

  assert.deepEqual(replies, [sparseReply]);
  assert.deepEqual(statuses, ["done"]);
  const record = records[0];
  assertValidRecord(record, "text");
  assert.equal(record.result, "ok");
  assert.equal(record.replySucceeded, true);
  assertRedacted(record, ["m-sparse", "chat-sparse", "这款酒如何"]);
});

test("reply failure then successful fallback is reply_error (not SLO ok) with redacted provider details", async () => {
  records.length = 0;
  const replies: string[] = [];
  let attempts = 0;
  install({
    replyFeishuMessage: async (_id: string, text: string) => {
      attempts++;
      replies.push(text);
      if (attempts === 1) throw new Error("Feishu reply failed: code 99999 secret-token-MAIN");
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-rf", chatId: "chat-rf", text: "hi" }));
  await drainFeishuMessages();

  assert.equal(attempts, 2);
  assert.match(replies[1], /暂时无法处理这条消息/);
  const record = records[0];
  assert.equal(record.result, "reply_error");
  assert.equal(record.replySucceeded, true);
  assertNonNegFinite(record.firstReplyLatencyMs, "firstReplyLatencyMs");
  assertRedacted(record, ["secret-token-MAIN", "Feishu reply failed", "m-rf", "chat-rf"]);
});

test("reply failure with failed fallback too stays reply_error, null latency, settled without throwing", async () => {
  records.length = 0;
  install({
    replyFeishuMessage: async () => {
      throw new Error("Feishu reply failed secret-token-ALL");
    },
  });

  await enqueueFeishuMessage(makeMessage({ messageId: "m-rfall", chatId: "chat-rfall", text: "hi" }));
  await drainFeishuMessages();

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.result, "reply_error");
  assert.equal(record.replySucceeded, false);
  assert.equal(record.firstReplyLatencyMs, null);
  assertNonNegFinite(record.replyMs, "replyMs");
  assertRedacted(record, ["secret-token-ALL", "Feishu reply failed"]);
});

test("sink failure (console.info throwing) never changes the message outcome", async () => {
  records.length = 0;
  const replies: string[] = [];
  install({
    replyFeishuMessage: async (id: string) => {
      replies.push(id);
    },
  });
  const collectingInfo = console.info;
  console.info = () => {
    throw new Error("sink broken secret-token-SINK");
  };
  try {
    await enqueueFeishuMessage(makeMessage({ messageId: "m-sink", chatId: "chat-sink", text: "hi" }));
    await drainFeishuMessages();
  } finally {
    console.info = collectingInfo;
  }
  assert.deepEqual(replies, ["m-sink"], "reply still happened despite sink failure");
});

test("image turn records image/agent/memory spans; post and unsupported types map correctly", async () => {
  records.length = 0;
  install({
    downloadFeishuImage: async () => {
      await sleep(10);
      return { type: "image/png", dataUrl: "data:image/png;base64,U1lOVEg=" };
    },
  });
  await enqueueFeishuMessage(
    makeMessage({ messageId: "m-img", chatId: "chat-img", messageType: "image", imageKey: "img-key" }),
  );
  await drainFeishuMessages();
  const imageRecord = records[0];
  assertValidRecord(imageRecord, "image");
  assert.equal(imageRecord.result, "ok");
  assertNonNegFinite(imageRecord.imageDownloadMs, "imageDownloadMs");
  assertNonNegFinite(imageRecord.agentMs, "agentMs");
  assertNonNegFinite(imageRecord.memoryWriteMs, "memoryWriteMs");
  assertRedacted(imageRecord, ["img-key", "m-img", "chat-img"]);

  records.length = 0;
  install();
  await enqueueFeishuMessage(
    makeMessage({ messageId: "m-post", chatId: "chat-post", messageType: "post", text: "post body secret" }),
  );
  await drainFeishuMessages();
  assertValidRecord(records[0], "post");
  assert.equal(records[0].result, "ok");
  assertRedacted(records[0], ["post body secret", "m-post", "chat-post"]);

  records.length = 0;
  const unsupportedReplies: string[] = [];
  install({
    replyFeishuMessage: async (_id: string, text: string) => {
      unsupportedReplies.push(text);
    },
  });
  await enqueueFeishuMessage(
    makeMessage({ messageId: "m-audio", chatId: "chat-audio", messageType: "audio" }),
  );
  await drainFeishuMessages();
  assertValidRecord(records[0], "other");
  assert.equal(records[0].result, "ok");
  assert.match(unsupportedReplies[0], /支持文字和图片/);
  assertRedacted(records[0], ["m-audio", "chat-audio"]);
});
