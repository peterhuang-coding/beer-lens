import './fixtures/controller-deadline-stubs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeadlineError } from '../lib/beer-agent/turn-deadline.ts';

const state = {
  modelCalls: 0,
  fallbackCalls: 0,
  memoryWrites: 0,
  fallbackMode: "normal" as "normal" | "never",
  onModelCall: undefined as undefined | ((options: any) => void),
};

function emptyPicks() {
  const e = { candidateId: '', label: '', reason: '暂无', worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

(globalThis as any).__beerControllerDeadlineStub = {
  buildAgentContext: async (request: any) => ({
    userId: request.userId,
    conversationId: request.conversationId,
    traceId: request.turnId,
    hasImage: Boolean(request.image?.dataUrl),
    imageDataUrl: request.image?.dataUrl,
    lastUserText: request.messages.at(-1)?.content ?? '',
    messages: request.messages,
    channel: request.channel,
    deadlineAtMs: request.deadlineAtMs,
    signal: request.signal,
    profileSummary: '',
    memorySnapshot: { shortTerm: { lastMenuCandidateCount: 0 } },
  }),
  describeContext: () => 'synthetic context',
  ensureSkillsLoaded: async () => {},
  buildSkillPrompt: () => 'synthetic selector prompt',
  parseSkillSelection: () => ({ skill: 'fallback', reason: 'synthetic', params: {} }),
  getSkill: () => undefined,
  keywordRoute: (text: string) => text === "skill deadline"
    ? { skill_id: "unclear", params: {}, reason: "synthetic skill route" }
    : null,
  agentTextFetch: async (_body: unknown, options: any) => {
    state.modelCalls++;
    state.onModelCall?.(options);
    return '{"skill":"fallback","reason":"synthetic","params":{}}';
  },
  writeTrace: async () => {},
  updateShortTermMemory: async () => { state.memoryWrites++; },
  recordTurnStart: () => Date.now(),
  recordTurnEnd: () => {},
  recordHandlerError: () => {},
  execute: async () => {
    state.fallbackCalls++;
    if (state.fallbackMode === "never") await new Promise(() => {});
    return { skillId: 'fallback', reply: 'late fallback', candidates: [], picks: emptyPicks(), profileSummary: '', errors: [] };
  },
};

const { runAgentTurn } = await import('../lib/agent/controller.ts');

function request(overrides: Record<string, unknown> = {}): any {
  return {
    userId: 'deadline-controller-user',
    channel: 'feishu',
    conversationId: 'deadline-controller-conversation',
    turnId: 'deadline-controller-turn',
    messages: [{ role: 'user', content: '没有规则命中的普通问题' }],
    ...overrides,
  };
}

test.beforeEach(() => {
  state.modelCalls = 0;
  state.fallbackCalls = 0;
  state.memoryWrites = 0;
  state.fallbackMode = "normal";
  state.onModelCall = undefined;
});

test('an already expired controller makes zero model calls and never enters fallback', async () => {
  await assert.rejects(
    runAgentTurn(request({ deadlineAtMs: Date.now() - 1 })),
    (error: any) => error?.code === 'turn_deadline_exceeded',
  );
  assert.equal(state.modelCalls, 0);
  assert.equal(state.fallbackCalls, 0);
});

test('abort during skill selection is terminal instead of launching fallback', async () => {
  const parent = new AbortController();
  state.onModelCall = () => parent.abort(new TurnDeadlineError());
  await assert.rejects(
    runAgentTurn(request({ deadlineAtMs: Date.now() + 10_000, signal: parent.signal })),
    (error: any) => error?.code === 'turn_deadline_exceeded',
  );
  assert.equal(state.modelCalls, 1);
  assert.equal(state.fallbackCalls, 0);
  assert.equal(state.memoryWrites, 0);
});

test('a skill that ignores abort cannot return a late success or write memory', async () => {
  state.fallbackMode = "never";
  const startedAt = Date.now();
  await assert.rejects(
    runAgentTurn(request({
      messages: [{ role: 'user', content: 'skill deadline' }],
      deadlineAtMs: Date.now() + 150,
    })),
    (error: any) => error?.code === 'turn_deadline_exceeded',
  );
  assert.ok(Date.now() - startedAt < 1_000, 'controller must stop waiting at the deadline');
  assert.equal(state.fallbackCalls, 1, 'the skill was started exactly once');
  assert.equal(state.memoryWrites, 0, 'an over-budget turn must not overwrite menu memory');
});
