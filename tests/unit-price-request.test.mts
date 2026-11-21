import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMenuInput } from '../lib/beer-agent/recommendation/menu-input.ts';
import { extractConstraints } from '../lib/beer-agent/recommendation/constraints.ts';

// Natural unit-price questions: “按每100ml…” asks for per-100ml ranking and
// must never be transcribed into a fictitious beer with a 100 ml serving.
const unitPriceRequests = [
  '按每100ml价格给我推荐最便宜的',
  '按每100毫升价格给我推荐最便宜的',
  '按每100ML价格给我推荐最便宜的',
  '按每100mL价格给我推荐最便宜的',
  '按每 100 ml 价格给我推荐最便宜的',
  '按 每100ml价格给我推荐最便宜的',
  '按 每 100 毫升 价格给我推荐最便宜的',
  '按每100ml价格排序',
  '按每100毫升推荐',
];

test('unit-price questions starting with 按每100ml stay pure request text', () => {
  for (const text of unitPriceRequests) {
    const parsed = parseMenuInput(text);
    assert.equal(parsed.items.length, 0, text);
    assert.equal(parsed.isMenu, false, text);
    assert.equal(parsed.requestText, text);
    assert.ok(!parsed.items.some(i => i.volumeMl === 100), text);
    assert.ok(!parsed.items.some(i => i.beerName.includes('按每')), text);
  }
});

test('the request still means unit-price goal and never a 100 ml serving constraint', () => {
  for (const text of unitPriceRequests) {
    const tokens = extractConstraints(text);
    assert.ok(tokens.includes('priceGoal:unit'), text);
    assert.ok(!tokens.some(t => /^(?:volumeMl|aroundVolumeMl):100$/.test(t)), text);
  }
});

test('an explicit menu followed by the unit-price question keeps every real row', () => {
  const parsed = parseMenuInput('酒单：\n1. 飞拳IPA ¥55 330ml 6.5%\n按每100ml价格给我推荐最便宜的');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].beerName, '飞拳IPA');
  assert.equal(parsed.items[0].price, 55);
  assert.equal(parsed.items[0].volumeMl, 330);
  assert.equal(parsed.items[0].abv, 6.5);
  assert.equal(parsed.requestText, '按每100ml价格给我推荐最便宜的');
  assert.equal(parsed.isMenu, true);
});

test('numbered and un-numbered menu rows keep names, prices and genuine volumes', () => {
  const numbered = parseMenuInput('酒单：\n1. 飞拳IPA ¥80 300ml 5%\n2. Pseudo Sue - Toppling Goliath ¥88 473ml 5.8%\n3. 黄河水 45/330 4.8%');
  assert.equal(numbered.isMenu, true);
  assert.equal(numbered.items.length, 3);
  assert.deepEqual(numbered.items.map(i => [i.beerName, i.price, i.volumeMl, i.abv]), [
    ['飞拳IPA', 80, 300, 5],
    ['Pseudo Sue', 88, 473, 5.8],
    ['黄河水', 45, 330, 4.8],
  ]);
  const plain = parseMenuInput('飞拳IPA ¥55 · 330ml · 6.5% ABV\n茉莉花茶拉格 35元 500ml');
  assert.equal(plain.items.length, 2);
  assert.equal(plain.items[0].beerName, '飞拳IPA');
  assert.equal(plain.items[0].price, 55);
  assert.equal(plain.items[0].volumeMl, 330);
  assert.equal(plain.items[1].beerName, '茉莉花茶拉格');
  assert.equal(plain.items[1].price, 35);
  assert.equal(plain.items[1].volumeMl, 500);
});

test('a genuine 100 ml serving row still keeps its volume fact', () => {
  const parsed = parseMenuInput('酒单：\n1. 试饮杯 30元 100ml 4%');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].beerName, '试饮杯');
  assert.equal(parsed.items[0].price, 30);
  assert.equal(parsed.items[0].volumeMl, 100);
  assert.equal(parsed.items[0].abv, 4);
});

test('explicit named-beer requests remain extractable', () => {
  assert.equal(parseMenuInput('推荐飞拳IPA').items[0]?.beerName, '飞拳IPA');
  assert.equal(parseMenuInput('推荐 Flying Fist IPA').items[0]?.beerName, 'Flying Fist IPA');
});

test('ordinary 每100ml and 按单位价 phrasing stays request text', () => {
  for (const text of ['每100ml价格怎么算', '按单位价推荐', '每 100 毫升 最便宜的']) {
    const parsed = parseMenuInput(text);
    assert.equal(parsed.items.length, 0, text);
    assert.equal(parsed.isMenu, false, text);
    assert.equal(parsed.requestText, text);
  }
});
