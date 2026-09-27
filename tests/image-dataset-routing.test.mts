import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { keywordRoute } from '../lib/harness/router-rules.ts';
import { registerSkill, _resetSkillsForTests } from './_helpers/router-test-helper.ts';

before(() => {
  _resetSkillsForTests();
  for (const id of ['menu_recommend', 'follow_up_filter', 'memory_correction'] as const) {
    registerSkill({ id, label: id, description: '隔离路由测试', enabled: true, preferredHandler: 'active', handlerFile: 'synthetic', invoke: async () => { throw new Error('本测试不执行模型处理器'); } });
  }
});
after(_resetSkillsForTests);
test('UT-I14 否定编号路由保留全文且不产生正向index', (t) => {
  const input = '不要菜单第7款'; const result = keywordRoute(input);
  const actual = { skill: result?.skill_id, index: result?.params.index ?? null, text: result?.params.free_text };
  const expected = { skill: 'follow_up_filter', index: null, text: input };
  t.diagnostic(JSON.stringify({ id: 'UT-I14', input, expected, actual, realVqa: false }));
  assert.deepEqual(actual, expected);
});
test('UT-I15 容量改为请求进入推荐路径而非记忆纠错', (t) => {
  const input = '容量改为473ml'; const actual = keywordRoute(input)?.skill_id; const expected = 'menu_recommend';
  t.diagnostic(JSON.stringify({ id: 'UT-I15', input, expected, actual, realVqa: false }));
  assert.equal(actual, expected);
});
