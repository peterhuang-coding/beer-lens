import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShortTermMemory, updateShortTermMemory, clearShortTermMemory } from '../lib/beer-agent/memory/short-term.ts';

test('UT-I16 图片会话重置仅删除指定合成用户会话', async (t) => {
  const originalCwd = process.cwd(); const temp = await mkdtemp(join(tmpdir(), 'beer-image-unit-'));
  try {
    process.chdir(temp);
    for (const userId of ['synthetic-image-a', 'synthetic-image-b']) {
      const pick = { candidateId: '', label: '' };
      await updateShortTermMemory({ userId, conversationId: 'synthetic-picture-session', turnId: 'synthetic-turn', messages: [{ role: 'user', content: '重新识别这张图片' }] } as never, { traceId: 'synthetic-trace', turnId: 'synthetic-turn', reply: '合成失败状态，仅供存储测试', candidates: [], picks: { topPick: pick, safePick: pick, explorePick: pick, avoidOrCaution: pick }, intentResult: { intent: 'menu_recommend' } } as never);
    }
    await clearShortTermMemory('synthetic-picture-session', 'synthetic-image-a');
    const actual = { target: await readShortTermMemory('synthetic-picture-session', 'synthetic-image-a'), otherTurns: (await readShortTermMemory('synthetic-picture-session', 'synthetic-image-b'))?.recentTurns.length };
    const input = '两个合成用户使用相同会话名，仅重置第一个用户'; const expected = { target: null, otherTurns: 1 };
    t.diagnostic(JSON.stringify({ id: 'UT-I16', input, expected, actual, realVqa: false, syntheticResponse: true }));
    assert.deepEqual(actual, expected);
  } finally {
    process.chdir(originalCwd); await rm(temp, { recursive: true, force: true });
  }
});
