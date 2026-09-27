import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShortTermMemory, updateShortTermMemory, clearShortTermMenu } from '../lib/beer-agent/memory/short-term.ts';

const originalCwd = process.cwd();
let temp: string;
before(async () => { temp = await mkdtemp(join(tmpdir(), 'beer-continuation-memory-')); process.chdir(temp); });
after(async () => { process.chdir(originalCwd); await rm(temp, { recursive: true, force: true }); });
const userId = 'synthetic-continuation-user';
const candidates = [
  { candidateId: 'synthetic-a', menuIndex: 7, displayName: '晴空拉格', brewery: '紫雀酒厂', style: 'Lager', abv: 5, ibu: 20, price: 50, volumeMl: 300, untappdScore: null, evidence: [{ source: 'manual_user_input', confidence: 1, summary: '合成酒单第7款' }] },
  { candidateId: 'synthetic-b', menuIndex: 42, displayName: '夜潮世涛', brewery: '合成黑鸟酒厂', style: 'Stout', abv: 7, ibu: 30, price: 70, volumeMl: 330, untappdScore: null, evidence: [{ source: 'manual_user_input', confidence: 1, summary: '合成酒单第42款' }] },
];
const menuText = '酒单：\n7. 晴空拉格 - 紫雀酒厂 ¥50 300ml\n42. 夜潮世涛 - 合成黑鸟酒厂 ¥70 330ml\n预算80元';
async function write(conversationId: string, text: string, rows = candidates, traceId = 'synthetic-old-menu', image = false, reply = '合成响应', user = userId) {
  const pick = { candidateId: rows[0]?.candidateId ?? '', label: rows[0]?.displayName ?? '' };
  const request = { userId: user, conversationId, turnId: traceId, messages: [{ role: 'user', content: text }], ...(image ? { image: { dataUrl: 'data:image/png;base64,synthetic-failure' } } : {}) };
  const response = { traceId, turnId: traceId, reply, candidates: rows, picks: { topPick: pick, safePick: pick, explorePick: pick, avoidOrCaution: pick }, intentResult: { intent: text.startsWith('第') ? 'follow_up_filter' : 'menu_recommend' } };
  await updateShortTermMemory(request as never, response as never);
}

test('UT-C22 多轮聚焦单款后仍保留完整菜单与印刷编号', async (t) => {
  const conversationId = 'synthetic-preserve';
  await write(conversationId, menuText);
  await write(conversationId, '第42款怎么样', [candidates[1]], 'synthetic-focus');
  const memory = await readShortTermMemory(conversationId, userId);
  const actual = { rows: memory?.lastMenu?.candidates.map(c => ({ id: c.candidateId, index: c.menuIndex, volumeMl: c.volumeMl, brewery: c.brewery })), active: memory?.activeBeer?.candidateId, constraints: memory?.currentConstraints, turns: memory?.recentTurns.length };
  t.diagnostic(JSON.stringify({ id: 'UT-C22', input: [menuText, '第42款怎么样'], expected: '完整两款菜单；聚焦第42款；预算80保留', actual, syntheticResponses: true }));
  assert.deepEqual(actual.rows, candidates.map(c => ({ id: c.candidateId, index: c.menuIndex, volumeMl: c.volumeMl, brewery: c.brewery })));
  assert.equal(actual.active, 'synthetic-b');
  assert.deepEqual(actual.constraints, ['maxPrice:80']);
  assert.equal(actual.turns, 2);
});
test('UT-C23 新酒厂菜单替换旧菜单和旧预算', async (t) => {
  const conversationId = 'synthetic-switch'; await write(conversationId, menuText);
  const next = [{ ...candidates[0], candidateId: 'synthetic-c', brewery: 'Silver Sparrow Brewing', menuIndex: 11, price: 40 }];
  const input = '酒单：\nSilver Sparrow Brewing\n11. 晴空拉格 ¥40 300ml\n预算50元';
  await write(conversationId, input, next, 'synthetic-new-menu');
  const memory = await readShortTermMemory(conversationId, userId);
  const actual = { ids: memory?.lastMenu?.candidates.map(c => c.candidateId), brewery: memory?.activeBeer?.brewery, constraints: memory?.currentConstraints, trace: memory?.lastMenu?.traceId };
  t.diagnostic(JSON.stringify({ id: 'UT-C23', input: [menuText, input], expected: '仅新酒厂候选；新预算50', actual, syntheticResponses: true }));
  assert.deepEqual(actual.ids, ['synthetic-c']);
  assert.equal(actual.brewery, 'Silver Sparrow Brewing');
  assert.deepEqual(actual.constraints, ['maxPrice:50']);
  assert.equal(actual.trace, 'synthetic-new-menu');
});
test('UT-C24 识图失败不把旧菜单来源改写为新图来源', async (t) => {
  const conversationId = 'synthetic-image-failure'; await write(conversationId, menuText);
  const input = '新酒单，预算60元';
  await write(conversationId, input, [], 'synthetic-failed-image', true, '识别失败，请重新上传');
  const memory = await readShortTermMemory(conversationId, userId);
  const actual = { menuTrace: memory?.lastMenu?.traceId, source: memory?.lastMenu?.source, ids: memory?.lastMenu?.candidates.map(c => c.candidateId), constraints: memory?.currentConstraints, latest: memory?.recentTurns.at(-1) };
  t.diagnostic(JSON.stringify({ id: 'UT-C24', input: [menuText, input], expected: '保留旧来源并记录失败；不应用新图预算', actual, syntheticFailure: true, realVqa: false }));
  assert.equal(actual.menuTrace, 'synthetic-old-menu');
  assert.equal(actual.source, 'text');
  assert.deepEqual(actual.ids, candidates.map(c => c.candidateId));
  assert.deepEqual(actual.constraints, ['maxPrice:80']);
  assert.equal(actual.latest?.assistantReply, '识别失败，请重新上传');
});
test('UT-C25 清理一名合成用户的菜单不影响另一名用户', async (t) => {
  const conversationId = 'synthetic-shared-conversation';
  await write(conversationId, menuText);
  await write(conversationId, menuText, [candidates[1]], 'synthetic-second-user', false, '合成响应', 'synthetic-other-user');
  await clearShortTermMenu(conversationId, userId);
  const first = await readShortTermMemory(conversationId, userId);
  const second = await readShortTermMemory(conversationId, 'synthetic-other-user');
  const actual = { cleared: { menu: first?.lastMenu ?? null, active: first?.activeBeer ?? null, constraints: first?.currentConstraints }, other: second?.lastMenu?.candidates.map(c => c.candidateId) };
  t.diagnostic(JSON.stringify({ id: 'UT-C25', input: '同会话名、不同合成用户；清空第一名用户菜单', expected: '只清空目标用户', actual }));
  assert.equal(actual.cleared.menu, null); assert.equal(actual.cleared.active, null);
  assert.deepEqual(actual.cleared.constraints, []);
  assert.deepEqual(actual.other, ['synthetic-b']);
});
