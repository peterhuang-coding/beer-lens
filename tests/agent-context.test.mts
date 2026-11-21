import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildAgentContext } from "../lib/agent/context.ts";

test("agent context preserves the caller's pipeline progress callback", async () => {
  const onProgress = () => {};
  const context = await buildAgentContext({
    userId: `context-progress-${randomUUID()}`,
    conversationId: `context-progress-${randomUUID()}`,
    turnId: "context-progress-test",
    channel: "cli",
    messages: [{ role: "user", content: "解读酒单" }],
    onProgress,
  });
  assert.equal(context.onProgress, onProgress);
});
