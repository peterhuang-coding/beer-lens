/**
 * Cache contract tests for effective multimodal request fields and governance.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/multimodal-cache-contract.test.mts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  vision,
  registerCapability,
  registerProvider,
  invalidateCache,
  VisionBlockedError,
} from "../lib/multimodal/index.ts";
import { _addRuleForTest, _removeRuleForTest } from "../lib/harness/rules.ts";
import type { VisionProvider } from "../lib/multimodal/providers/base.ts";
import type { CapabilityInput } from "../lib/multimodal/types.ts";

const BASE_INPUT: CapabilityInput = {
  image: { base64: "aGVsbG8=", mime: "image/jpeg" },
  prompt: "read this image",
};

interface CallRecord {
  provider: string;
  model: string;
  schema?: object;
  schemaName?: string;
  maxTokens?: number;
}

function makeRecordingProvider(
  id: string,
  calls: CallRecord[],
  respond: (model: string) => string,
): VisionProvider {
  return {
    id,
    async call(input, opts) {
      calls.push({
        provider: id,
        model: opts.model,
        schema: input.schema,
        schemaName: input.schemaName,
        maxTokens: input.maxTokens,
      });
      return respond(opts.model);
    },
  };
}

function responseRule(id: string, blockedText: string) {
  return {
    id,
    stage: "post-vision" as const,
    enabled: true,
    priority: 999,
    description: "block selected vision response",
    evaluate(ctx: { llm_response?: unknown }) {
      const text =
        typeof ctx.llm_response === "string"
          ? ctx.llm_response
          : JSON.stringify(ctx.llm_response ?? "");
      if (text.includes(blockedText)) {
        return { kind: "block" as const, reason: `blocked ${blockedText}` };
      }
      return null;
    },
  };
}

function setupCapability(id: string) {
  const calls: CallRecord[] = [];
  registerProvider(makeRecordingProvider("cache-contract-alpha", calls, () => '"alpha"'));
  registerProvider(makeRecordingProvider("cache-contract-beta", calls, () => '"beta"'));
  registerProvider(makeRecordingProvider("cache-contract-first", calls, () => '"first"'));
  registerProvider(makeRecordingProvider("cache-contract-second", calls, () => '"second"'));
  registerCapability({
    id,
    description: "multimodal cache contract test capability",
    defaultProviders: [
      { provider: "cache-contract-alpha", models: ["alpha-model"], timeoutMs: 1000 },
      { provider: "cache-contract-first", models: ["first-model"], timeoutMs: 1000 },
    ],
  });
  return calls;
}

test("effective schemaName and schema are passed to provider and separate cache entries", async () => {
  invalidateCache();
  const capId = "cache_contract_schema_fields";
  const calls = setupCapability(capId);

  const first = await vision.call(capId, BASE_INPUT, {
    schema: { type: "object", properties: { alpha: { type: "string" } } },
    schemaName: "alpha",
    maxTokens: 100,
  });
  const second = await vision.call(capId, BASE_INPUT, {
    schema: { type: "object", properties: { beta: { type: "string" } } },
    schemaName: "beta",
    maxTokens: 100,
  });

  assert.equal(first.raw, '"alpha"');
  assert.equal(second.raw, '"alpha"');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].schema, { type: "object", properties: { alpha: { type: "string" } } });
  assert.equal(calls[0].schemaName, "alpha");
  assert.equal(calls[0].maxTokens, 100);
  assert.deepEqual(calls[1].schema, { type: "object", properties: { beta: { type: "string" } } });
  assert.equal(calls[1].schemaName, "beta");
  assert.equal(calls[1].maxTokens, 100);
});

test("identical effective request is served from the warm cache", async () => {
  invalidateCache();
  const capId = "cache_contract_identical_hit";
  const calls = setupCapability(capId);
  const opts = { schemaName: "same", maxTokens: 88 };

  const first = await vision.call(capId, BASE_INPUT, opts);
  const second = await vision.call(capId, BASE_INPUT, { schemaName: "same", maxTokens: 88 });

  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(second.raw, first.raw);
  assert.equal(calls.length, 1);
});

test("provider and model chain changes invalidate cached response", async () => {
  invalidateCache();
  const capId = "cache_contract_chain_fields";
  const calls = setupCapability(capId);

  const first = await vision.call(capId, BASE_INPUT, {
    providers: [
      { provider: "cache-contract-first", models: ["first-model"], timeoutMs: 1000 },
    ],
  });
  const second = await vision.call(capId, BASE_INPUT, {
    providers: [
      { provider: "cache-contract-second", models: ["second-model"], timeoutMs: 1000 },
    ],
  });

  assert.equal(first.raw, '"first"');
  assert.equal(second.raw, '"second"');
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].provider, calls[0].model], ["cache-contract-first", "first-model"]);
  assert.deepEqual([calls[1].provider, calls[1].model], ["cache-contract-second", "second-model"]);
});

test("postblock response is not cached, repeats call provider, and does not try next provider", async () => {
  invalidateCache();
  const capId = "cache_contract_postblock_uncached";
  const calls = setupCapability(capId);
  const ruleId = "cache-contract-block-alpha";
  _addRuleForTest(responseRule(ruleId, "alpha"));

  try {
    await assert.rejects(
      () => vision.call(capId, BASE_INPUT, { schemaName: "postblock" }),
      (e: unknown) => e instanceof VisionBlockedError,
    );
    await assert.rejects(
      () => vision.call(capId, BASE_INPUT, { schemaName: "postblock" }),
      (e: unknown) => e instanceof VisionBlockedError,
    );
  } finally {
    _removeRuleForTest(ruleId);
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => [c.provider, c.model]),
    [
      ["cache-contract-alpha", "alpha-model"],
      ["cache-contract-alpha", "alpha-model"],
    ],
  );
});

test("a new post-vision rule rejects a response that was previously cached", async () => {
  invalidateCache();
  const capId = "cache_contract_rule_invalidates_hit";
  const calls = setupCapability(capId);

  const accepted = await vision.call(capId, BASE_INPUT, { schemaName: "rule-change" });
  assert.equal(accepted.fromCache, false);

  const ruleId = "cache-contract-block-cached-alpha";
  _addRuleForTest(responseRule(ruleId, "alpha"));
  try {
    await assert.rejects(
      () => vision.call(capId, BASE_INPUT, { schemaName: "rule-change" }),
      (e: unknown) => e instanceof VisionBlockedError,
    );
  } finally {
    _removeRuleForTest(ruleId);
  }

  assert.equal(calls.length, 1);
});

test('each effective response field and capability default independently separates entries', async () => {
  invalidateCache();
  const id='cache_contract_independent_fields';
  const calls=setupCapability(id);
  const input={...BASE_INPUT,schemaName:'base',schema:{type:'string'},maxTokens:90};
  await vision.call(id,input);
  await vision.call(id,input,{schemaName:'other'});
  await vision.call(id,input,{maxTokens:91});
  await vision.call(id,input,{schema:{type:'number'}});
  await vision.call(id,input,{providers:[{provider:'cache-contract-alpha',models:['other-model'],timeoutMs:1000}]});
  assert.equal(calls.length,5);
  registerCapability({id,description:'changed defaults',schemaName:'default-a',schema:{type:'string'},defaultProviders:[{provider:'cache-contract-alpha',models:['alpha-model'],timeoutMs:1000}]});
  await vision.call(id,BASE_INPUT);
  registerCapability({id,description:'changed defaults',schemaName:'default-b',schema:{type:'number'},defaultProviders:[{provider:'cache-contract-alpha',models:['alpha-model'],timeoutMs:1000}]});
  const changed=await vision.call(id,BASE_INPUT);
  assert.equal(changed.fromCache,false);
  assert.equal(calls.length,7);
});
