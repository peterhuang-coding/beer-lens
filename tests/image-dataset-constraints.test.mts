import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConstraints, mergeConstraints, constraintFailures } from '../lib/beer-agent/recommendation/constraints.ts';

test('UT-I07 改成473ml只替换容量并保留预算和ABV', (t) => {
  const input = ['只要300ml，预算80元，ABV最多8%', '容量改成473ml'];
  const actual = mergeConstraints(extractConstraints(input[0]), extractConstraints(input[1]));
  const expected = ['maxPrice:80', 'maxAbv:8', 'volumeMl:473'];
  t.diagnostic(JSON.stringify({ id: 'UT-I07', input, expected, actual, realVqa: false }));
  assert.deepEqual(actual, expected);
});
test('UT-I08 改为473ml替换旧容量且允许符合条件的候选', (t) => {
  const input = ['只要300ml，预算80元', '容量改为473ml'];
  const constraints = mergeConstraints(extractConstraints(input[0]), extractConstraints(input[1]));
  const candidate = { displayName: 'Thor Pour', price: 60, volumeMl: 473, abv: 8 };
  const actual = { constraints, failures: constraintFailures(candidate, constraints) };
  const expected = { constraints: ['maxPrice:80', 'volumeMl:473'], failures: [] };
  t.diagnostic(JSON.stringify({ id: 'UT-I08', input, candidate, expected, actual, syntheticOffer: true, realVqa: false }));
  assert.deepEqual(actual, expected);
});
test('UT-I09 图片未知的ABV价量不能默认为满足硬条件', (t) => {
  const candidate = { displayName: 'West Coast Aroma', brewery: 'Monkish', abv: 0, price: null, volumeMl: null };
  const input = { candidate, request: '只要473ml，预算80元，ABV最多8%' };
  const actual = constraintFailures(candidate, extractConstraints(input.request));
  const expected = ['价格未知', '酒精度未知', '容量未知'];
  t.diagnostic(JSON.stringify({ id: 'UT-I09', image: 'IMG-N002', input, expected, actual, realVqa: false }));
  for (const fragment of expected) assert.ok(actual.some(reason => reason.includes(fragment)), fragment);
});
