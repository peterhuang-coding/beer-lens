/**
 * tests/llm-streaming.test.mts
 *
 * Unit tests for the SSE parser used by every OpenAI-compat adapter.
 * Does NOT touch the network — feeds a hand-crafted SSE stream and
 * asserts the parsed events.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSE } from "../lib/harness/llm/streaming.ts";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

test("parseSSE: parses one full record split across two chunks", async () => {
  // Same record, but the second chunk lands mid-line — the parser must
  // wait for the blank-line separator before yielding.
  const stream = sseStream([
    'data: {"choices":[{"delta":{"content":"hel',
    'lo"},"index":0}]}\n\n',
  ]);
  const out: unknown[] = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  assert.equal(out.length, 1);
  const rec = out[0] as { data: { choices: Array<{ delta: { content: string } }> } };
  assert.equal(rec.data.choices[0].delta.content, "hello");
});

test("parseSSE: handles [DONE] sentinel and skips comment lines", async () => {
  const stream = sseStream([
    ": keep-alive comment\n",
    'data: {"choices":[{"delta":{"content":"a"},"index":0}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const out: Array<{ data: unknown }> = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  assert.equal(out.length, 1);
  const rec = out[0] as { data: { choices: Array<{ delta: { content: string } }> } };
  assert.equal(rec.data.choices[0].delta.content, "a");
});

test("parseSSE: drops malformed JSON payloads without throwing", async () => {
  const stream = sseStream([
    "data: not-json-at-all\n\n",
    'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
  ]);
  const out: Array<{ data: unknown }> = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  // First record is null-data (skipped), second survives.
  assert.equal(out.length, 1);
  const rec = out[0] as { data: { choices: Array<{ delta: { content: string } }> } };
  assert.equal(rec.data.choices[0].delta.content, "ok");
});

test("parseSSE: emits event=meta when an `event:` field is present", async () => {
  const stream = sseStream([
    'event: meta\ndata: {"skill_id":"menu_recommend"}\n\n',
  ]);
  const out: Array<{ event: string; data: unknown }> = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  assert.equal(out[0].event, "meta");
  const rec = out[0] as { data: { skill_id: string } };
  assert.equal(rec.data.skill_id, "menu_recommend");
});

test("parseSSE: handles trailing record without trailing blank line", async () => {
  const stream = sseStream([
    'data: {"choices":[{"delta":{"content":"x"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{"content":"y"},"index":0}]}',
  ]);
  const out: Array<{ data: { choices: Array<{ delta: { content: string } }> } }> = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  assert.equal(out.length, 2);
  assert.equal(out[0].data.choices[0].delta.content, "x");
  assert.equal(out[1].data.choices[0].delta.content, "y");
});