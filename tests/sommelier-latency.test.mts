import './fixtures/knowledge-deadline-stubs.mjs';
import './fixtures/pipeline-deadline-stubs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vision } from '../lib/multimodal/index.ts';
import { TurnDeadlineError } from '../lib/beer-agent/turn-deadline.ts';

(globalThis as any).__beerPipelineDeadlineStub = {
  openrouterFetch: async () => { throw new Error('test must install a synthetic transport'); },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error('sommelier-latency network deny guard');
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

// Module hooks must be installed before resolving the module under test.
const { runMultiStagePipeline } = await import('../lib/beer-agent/multi-stage-pipeline.ts');

const knowledgeCalls: Array<{ body: unknown; options: any }> = [];
(globalThis as any).__beerKnowledgeDeadlineStub = {
  agentTextFetch: async (body: unknown, options: any) => {
    knowledgeCalls.push({ body, options });
    return 'synthetic grounded answer';
  },
  readShortTermMemory: async () => null,
  lookupBeers: async () => [],
};

const { execute: executeKnowledge } = await import('../lib/skills/beer-knowledge/execute.ts');

function knowledgeContext(overrides: Record<string, unknown> = {}): any {
  return {
    userId: 'deadline-user',
    conversationId: 'deadline-conversation',
    traceId: 'deadline-trace',
    hasImage: false,
    lastUserText: '这款酒用了什么酒花？',
    messages: [{ role: 'user', content: '这款酒用了什么酒花？' }],
    channel: 'feishu',
    profileSummary: '',
    ...overrides,
  };
}

test('multi-stage vision forwards the caller signal by identity', async () => {
  const original = vision.call;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  vision.call = (async (_capability: string, _input: unknown, options: any) => {
    receivedSignal = options?.signal;
    return {
      parsed: {
        imageContext: { imageType: 'menu' },
        extracted: { items: [{ beerName: 'Deadline Ale' }] },
        visualQuality: { canAssess: false },
      },
    };
  }) as typeof vision.call;
  try {
    await runMultiStagePipeline({
      apiKey: 'test', imageDataUrl: 'data:image/png;base64,eA==', userText: '', profile: '',
      skipRecommendation: true, signal: controller.signal,
    } as any);
    assert.equal(receivedSignal, controller.signal);
  } finally {
    vision.call = original;
  }
});

test('knowledge model gets the same signal and only the remaining turn budget', async () => {
  knowledgeCalls.length = 0;
  const controller = new AbortController();
  const result = await executeKnowledge(knowledgeContext({
    signal: controller.signal,
    deadlineAtMs: Date.now() + 1_200,
  }), {});
  assert.equal(result.reply, 'synthetic grounded answer');
  assert.equal(knowledgeCalls.length, 1);
  assert.equal(knowledgeCalls[0].options?.signal, controller.signal);
  assert.ok(knowledgeCalls[0].options?.timeoutMs > 0);
  assert.ok(knowledgeCalls[0].options?.timeoutMs <= 1_200);
});

test('an expired knowledge turn makes zero model requests', async () => {
  knowledgeCalls.length = 0;
  const result = await executeKnowledge(knowledgeContext({ deadlineAtMs: Date.now() - 1 }), {});
  assert.equal(knowledgeCalls.length, 0);
  assert.ok(result.errors.length > 0, 'deadline degradation stays observable');
});

function syntheticJson(body: any): string {
  const schemaName = body?.response_format?.json_schema?.name;
  if (schemaName === 'beer_signal_extract') {
    return JSON.stringify({
      sourceType: 'text', rawText: 'Deadline Ale', items: [],
      visualBeerDescription: { color: '', clarity: '', foam: '', visiblePackagingDate: '', notes: [] },
      uncertainties: [],
    });
  }
  return JSON.stringify({
    reply: 'synthetic recommendation', topPickId: '1', safePickId: '1',
    explorePickId: '1', avoidPickId: '', topReason: '', safeReason: '',
    exploreReason: '', avoidReason: '',
  });
}

test('an expired text-only multi-stage turn makes zero legacy model calls', async () => {
  const controller = new AbortController();
  controller.abort(new TurnDeadlineError());
  let calls = 0;
  (globalThis as any).__beerPipelineDeadlineStub.openrouterFetch = async (body: any) => {
    calls++;
    return syntheticJson(body);
  };
  await assert.rejects(runMultiStagePipeline({
    apiKey: 'synthetic', imageDataUrl: null, userText: 'Deadline Ale', profile: '',
    signal: controller.signal,
  }), (error: any) => error?.code === 'turn_deadline_exceeded');
  assert.equal(calls, 0);
});

test('non-skip recommendation receives the caller signal', async () => {
  const original = vision.call;
  const controller = new AbortController();
  const optionsSeen: any[] = [];
  vision.call = (async () => ({
    parsed: {
      imageContext: { imageType: 'menu' },
      extracted: { items: [{ menuIndex: 1, beerName: 'Deadline Ale', brewery: '', style: 'IPA', abv: 6 }] },
      visualQuality: { canAssess: false, visualRiskFlags: [] },
    },
  })) as typeof vision.call;
  (globalThis as any).__beerPipelineDeadlineStub.openrouterFetch = async (body: any, options: any) => {
    optionsSeen.push(options);
    return syntheticJson(body);
  };
  try {
    await runMultiStagePipeline({
      apiKey: 'synthetic', imageDataUrl: 'data:image/png;base64,eA==', userText: '', profile: '',
      signal: controller.signal,
    });
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.signal, controller.signal);
  } finally {
    vision.call = original;
  }
});

test('abort after a legacy model failure stops the fallback chain', async () => {
  const controller = new AbortController();
  let calls = 0;
  (globalThis as any).__beerPipelineDeadlineStub.openrouterFetch = async () => {
    calls++;
    controller.abort(new TurnDeadlineError());
    throw new Error('synthetic transport closed');
  };
  await assert.rejects(runMultiStagePipeline({
    apiKey: 'synthetic', imageDataUrl: null, userText: 'Deadline Ale', profile: '',
    signal: controller.signal,
  }), (error: any) => error?.code === 'turn_deadline_exceeded');
  assert.equal(calls, 1, 'no next model may start after abort');
});
