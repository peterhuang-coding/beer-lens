import assert from 'node:assert/strict';
import { invokeSkill, getSkill, registerSkill } from '../../lib/harness/skill-registry.ts';
import { getTreeByRoot, listTraceEntries } from '../../lib/harness/trace-buffer.ts';
import { POST } from '../../app/api/chat/route.ts';

const secret = 'credential-sentinel-do-not-expose';
process.env.OPENROUTER_API_KEY = 'test-key';
globalThis.fetch = async () => new Response(`upstream auth failed: ${secret}`, { status: 401 });
const root = Date.now();
const ctx = {
  userId: 'failure-test', conversationId: 'failure-test',
  request: { userId: 'failure-test', conversationId: 'failure-test', turnId: 'test', channel: 'web' as const, messages: [{ role: 'user' as const, content: 'IPA' }] },
  _trace_ctx: { root_ts: root, parent_ts: root },
};
const result = await invokeSkill('beer_knowledge', ctx);
assert.equal(result.ok, false, 'a caught provider error must not become success');
if (result.ok) throw new Error('expected failure');
assert.equal(result.error, 'skill_failed');
assert.ok(!result.message.includes(secret));
const invocation = getTreeByRoot(root).find(entry => entry.stage === 'skill:invoke');
assert.equal(invocation?.ok, false, 'skill trace must record failure');
assert.equal(invocation?.decision?.error_count, 1);

// Exercise the actual chat stream using the same failure without a database or network call.
const skill = getSkill('beer_knowledge')!;
const fallback = await invokeSkill('unclear', { ...ctx, _trace_ctx: undefined });
assert.equal(fallback.ok, true, 'successful skills retain their reply');
if (!fallback.ok) throw new Error('expected success');
registerSkill({ ...skill, invoke: async () => ({ ...fallback, errors: [`provider: ${secret}`], reply: `unsafe apology ${secret}` }) });
const response = await POST(new Request('http://localhost/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '什么是 IPA', conversationId: 'failure-test' }),
}));
const sse = await response.text();
assert.match(sse, /event: error\ndata: .*"code":"skill_failed"/);
assert.doesNotMatch(sse, /event: delta/);
assert.ok(!sse.includes(secret), 'SSE must not expose upstream credentials');
const chats = listTraceEntries(20).filter(entry => entry.stage === 'chat' && entry.skill_id === 'beer_knowledge');
assert.ok(chats.some(entry => !entry.ok && entry.error_code === 'skill_failed'), 'failed chat must be counted in trace metrics');

registerSkill({ ...skill, invoke: async () => { throw new Error(secret); } });
const thrown = await invokeSkill('beer_knowledge', ctx);
assert.equal(thrown.ok, false, 'thrown executor errors use the same safe failure contract');
if (!thrown.ok) assert.ok(!thrown.message.includes(secret));
