import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConstraints, mergeConstraints, constraintFailures } from '../lib/beer-agent/recommendation/constraints.ts';

const base = { displayName: '合成晴空拉格', style: 'Lager', price: 50, volumeMl: 300, abv: 5, ibu: 20, currency: 'CNY' };

test('UT-C06 修改预算时保留风格与ABV和IBU', (t) => {
  const input = ['IPA，预算80元，ABV不超过7%，IBU 30以下', '放宽到90元'];
  const actual = mergeConstraints(extractConstraints(input[0]), extractConstraints(input[1]));
  const expected = ['IPA', 'maxAbv:7', 'maxIbu:30', 'maxPrice:90'];
  t.diagnostic(JSON.stringify({ id: 'UT-C06', input, expected, actual }));
  assert.deepEqual(actual, expected);
});
test('UT-C07 风格切换替换旧风格并保留预算和酒精度', (t) => {
  const input = ['只要IPA，预算80元，ABV不超过7%', '换成世涛'];
  const actual = mergeConstraints(extractConstraints(input[0]), extractConstraints(input[1]));
  const expected = ['maxPrice:80', 'maxAbv:7', 'stout'];
  t.diagnostic(JSON.stringify({ id: 'UT-C07', input, expected, actual }));
  assert.deepEqual(actual, expected);
});
test('UT-C08 IBU上限不建立价格上限', (t) => {
  const input = 'IBU最多30'; const actual = extractConstraints(input);
  t.diagnostic(JSON.stringify({ id: 'UT-C08', input, expected: ['maxIbu:30'], actual }));
  assert.deepEqual(actual, ['maxIbu:30']);
});
test('UT-C09 容量上限不建立价格上限', (t) => {
  const input = '容量最多300ml'; const actual = extractConstraints(input);
  t.diagnostic(JSON.stringify({ id: 'UT-C09', input, expected: '不含 minPrice/maxPrice', actual }));
  assert.ok(!actual.some(value => /^(?:min|max)Price:/.test(value)));
});
test('UT-C10 预算改成的新金额替换旧金额', (t) => {
  const input = ['只要拉格，预算80元，ABV不超过6%', '预算改成60元'];
  const actual = mergeConstraints(extractConstraints(input[0]), extractConstraints(input[1]));
  const expected = ['lager', 'maxAbv:6', 'maxPrice:60'];
  t.diagnostic(JSON.stringify({ id: 'UT-C10', input, expected, actual }));
  assert.deepEqual(actual, expected);
});
test('UT-C11 只要300ml时排除500ml的大杯', (t) => {
  const input = '只要300ml'; const constraints = extractConstraints(input);
  const actual = { constraints, small: constraintFailures(base, constraints), large: constraintFailures({ ...base, volumeMl: 500 }, constraints) };
  t.diagnostic(JSON.stringify({ id: 'UT-C11', input, expected: '300ml符合；500ml存在容量不符理由', actual }));
  assert.deepEqual(actual.small, []);
  assert.ok(actual.large.length > 0, '明确容量要求必须影响候选过滤');
});
test('UT-C12 未知价格和超预算候选均不能被当成预算内', (t) => {
  const input = '预算60元'; const constraints = extractConstraints(input);
  const actual = [base, { ...base, price: null }, { ...base, price: 61 }].map(candidate => constraintFailures(candidate, constraints));
  t.diagnostic(JSON.stringify({ id: 'UT-C12', input, expected: '50元通过；未知与61元排除', actual }));
  assert.deepEqual(actual[0], []);
  assert.ok(actual[1].some(reason => reason.includes('未知')));
  assert.ok(actual[2].some(reason => reason.includes('超出预算')));
});
