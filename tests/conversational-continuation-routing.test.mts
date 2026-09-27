import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 注册表从工作目录加载自定义配置；仅在隔离目录加载，避免读取用户状态。
const originalCwd = process.cwd();
let temp: string;
let registry: typeof import('../lib/beer-agent/intent-registry.ts');
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'beer-continuation-routing-'));
  process.chdir(temp);
  registry = await import('../lib/beer-agent/intent-registry.ts');
});
after(async () => { process.chdir(originalCwd); await rm(temp, { recursive: true, force: true }); });
const context = (active = false) => ({ hasImage: false, hasActiveMenu: active, turnsSinceMenu: active ? 1 : 0, activeMenuCandidateCount: active ? 2 : 0, hasTastingHistory: false, episodeCount: 0 });

test('UT-C01 普通问候不进入酒单推荐', (t) => {
  const input = '你好'; const actual = registry.classify(input, context()).primary;
  t.diagnostic(JSON.stringify({ id: 'UT-C01', input, expected: 'unclear', actual }));
  assert.equal(actual, 'unclear');
});
test('UT-C02 合成酒厂历史问题进入知识路由', (t) => {
  const input = '介绍紫雀酒厂历史'; const actual = registry.classify(input, context()).primary;
  t.diagnostic(JSON.stringify({ id: 'UT-C02', input, expected: 'beer_knowledge', actual, syntheticBrewery: true }));
  assert.equal(actual, 'beer_knowledge');
});
test('UT-C03 同一编号追问由活跃菜单状态决定路由', (t) => {
  const input = '第7款怎么样';
  const actual = [registry.classify(input, context(false)).primary, registry.classify(input, context(true)).primary];
  t.diagnostic(JSON.stringify({ id: 'UT-C03', input, expected: ['unclear', 'follow_up_filter'], actual }));
  assert.deepEqual(actual, ['unclear', 'follow_up_filter']);
});
test('UT-C04 活跃菜单中的预算改写继续筛选', (t) => {
  const input = '预算改成60元'; const result = registry.classify(input, context(true));
  t.diagnostic(JSON.stringify({ id: 'UT-C04', input, expected: 'follow_up_filter', actual: result.primary, matchedRules: result.diagnosis.matchedRules }));
  assert.equal(result.primary, 'follow_up_filter');
});
test('UT-C05 指定酒厂的风格请求不生成整句酒款名', (t) => {
  const input = '帮我推荐京A的拉格'; const actual = registry.extractSlots(input, 'menu_recommend');
  t.diagnostic(JSON.stringify({ id: 'UT-C05', input, expected: '无虚构 beerName', actual, mbcbCoverage: false }));
  assert.equal(actual.beerName, undefined);
});
