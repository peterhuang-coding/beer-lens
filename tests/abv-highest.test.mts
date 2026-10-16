import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractConstraints,
  mergeConstraints,
  constraintFailures,
} from '../lib/beer-agent/recommendation/constraints.ts';

// Exact original user sentence from baseline-evidence.json — must not be reworded.
const ORIGINAL_SENTENCE = '换成500ml的，ABV最高10%，预算120';
const PRIOR_TURN = ['maxAbv:8', 'aroundVolumeMl:330', 'maxPrice:100'];

test('原句提取: ABV最高10% 必须给出 maxAbv:10，且保留容量与预算', () => {
  assert.deepEqual(extractConstraints(ORIGINAL_SENTENCE), [
    'maxPrice:120',
    'maxAbv:10',
    'volumeMl:500',
  ]);
});

test('ABV最高 变体: 酒精度、小写 abv、空格、小数、改写连接词均保留上限语义', () => {
  assert.deepEqual(extractConstraints('酒精度最高10%'), ['maxAbv:10']);
  assert.deepEqual(extractConstraints('abv最高10%'), ['maxAbv:10']);
  assert.deepEqual(extractConstraints('ABV 最高 10%'), ['maxAbv:10']);
  assert.deepEqual(extractConstraints('ABV最高5.5%'), ['maxAbv:5.5']);
  assert.deepEqual(extractConstraints('ABV改为最高10%'), ['maxAbv:10']);
});

test('合并: 新一轮显式约束按族替换旧的 maxAbv/aroundVolumeMl/maxPrice', () => {
  const merged = mergeConstraints(PRIOR_TURN, extractConstraints(ORIGINAL_SENTENCE));
  assert.deepEqual(merged, ['maxPrice:120', 'maxAbv:10', 'volumeMl:500']);
  assert.ok(!merged.includes('maxAbv:8'));
  assert.ok(!merged.includes('aroundVolumeMl:330'));
  assert.ok(!merged.includes('maxPrice:100'));
});

const merged = mergeConstraints(PRIOR_TURN, extractConstraints(ORIGINAL_SENTENCE));
const beer95 = {
  currency: 'CNY',
  displayName: '合成回归测试啤酒',
  price: 90,
  volumeMl: 500,
  abv: 9.5,
};

test('放宽到10%后: 9.5% / ¥90 / 500ml 候选不再有任何约束失败', () => {
  assert.deepEqual(constraintFailures(beer95, merged), []);
});

test('边界: 11% 候选仍因 maxAbv:10 失败，且只报 ABV 一项', () => {
  const failures = constraintFailures({ ...beer95, abv: 11 }, merged);
  assert.deepEqual(failures, ['酒精度不符合要求']);
});

test('旧有 ABV 上限短语保留: 不超过 / 最多 / N%以下', () => {
  assert.deepEqual(extractConstraints('ABV不超过8'), ['maxAbv:8']);
  assert.deepEqual(extractConstraints('ABV最多6%'), ['maxAbv:6']);
  assert.deepEqual(extractConstraints('10%以下'), ['maxAbv:10']);
});

test('旧有 ABV 范围短语保留: ABV5-10%', () => {
  assert.deepEqual(extractConstraints('ABV5-10%'), ['minAbv:5', 'maxAbv:10']);
});

test('无数字的最高类问句不产生任何约束: 哪款ABV最高？', () => {
  assert.deepEqual(extractConstraints('哪款ABV最高？'), []);
});

test('最高价格/IBU/评分问句不会产生 ABV 约束', () => {
  for (const question of ['哪杯价格最高？', 'IBU最高的是哪款', '评分最高的啤酒']) {
    const got = extractConstraints(question);
    assert.ok(
      !got.some((c) => /Abv/.test(c)),
      `${question} produced ABV constraint: ${JSON.stringify(got)}`,
    );
  }
});

test('预算与容量单族短语保持本族，不被最高措辞干扰', () => {
  assert.deepEqual(extractConstraints('预算120'), ['maxPrice:120']);
  assert.deepEqual(extractConstraints('换成500ml的'), ['volumeMl:500']);
});

test('最高问句与预算/容量同句时不劫持其家族，也不伪造 ABV 数字', () => {
  assert.deepEqual(extractConstraints('预算120，哪款ABV最高？'), ['maxPrice:120']);
  assert.deepEqual(extractConstraints('换成500ml的，哪款ABV最高？'), ['volumeMl:500']);
});
