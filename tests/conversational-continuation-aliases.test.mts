import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChineseAlias, lookupChineseBeerName } from '../lib/beer-agent/beer-db/aliases.ts';

// 此处仅验证仓库既有别名，不把这些实体推断为 MBCB 参展名单。
test('UT-C18 已知中文酒款别名解析为完整英文酒名', (t) => {
  const input = '暴龙苏'; const actual = resolveChineseAlias(input);
  const expected = { name: 'Pseudo Sue', query: 'Pseudo Sue', exact: true };
  t.diagnostic(JSON.stringify({ id: 'UT-C18', input, expected, actual, mbcbCoverage: false }));
  assert.deepEqual(actual, expected);
});
test('UT-C19 酒款别名后的酒厂限定保留在查询中', (t) => {
  const input = '暴龙苏 Toppling Goliath'; const actual = resolveChineseAlias(input);
  const expected = { name: 'Pseudo Sue', query: 'Pseudo Sue Toppling Goliath', exact: true };
  t.diagnostic(JSON.stringify({ id: 'UT-C19', input, expected, actual, mbcbCoverage: false }));
  assert.deepEqual(actual, expected);
});
test('UT-C20 离题文本中的同名子串不命中酒款', (t) => {
  const input = ['春分节气是什么', '午餐吃什么', '马赛克瓷砖'];
  const actual = input.map(lookupChineseBeerName);
  t.diagnostic(JSON.stringify({ id: 'UT-C20', input, expected: [null, null, null], actual }));
  assert.deepEqual(actual, [null, null, null]);
});
test('UT-C21 仅有酒厂名时不冒充某一具体酒款', (t) => {
  const input = ['京A', 'Jing-A', '紫雀酒厂']; const actual = input.map(lookupChineseBeerName);
  t.diagnostic(JSON.stringify({ id: 'UT-C21', input, expected: [null, null, null], actual, mbcbCoverage: false }));
  assert.deepEqual(actual, [null, null, null]);
});
