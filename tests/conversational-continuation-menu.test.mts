import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMenuInput, parseOrdinalReference } from '../lib/beer-agent/recommendation/menu-input.ts';

test('UT-C13 中英文合成酒厂标题切换保留同名酒款所属酒厂', (t) => {
  const input = '酒单：\n紫雀酒厂\n7. 晴空拉格 ¥50\nSilver Sparrow Brewing\n11. 晴空拉格 ¥60';
  const actual = parseMenuInput(input).items.map(item => ({ name: item.beerName, brewery: item.brewery, index: item.menuIndex }));
  const expected = [{ name: '晴空拉格', brewery: '紫雀酒厂', index: 7 }, { name: '晴空拉格', brewery: 'Silver Sparrow Brewing', index: 11 }];
  t.diagnostic(JSON.stringify({ id: 'UT-C13', input, expected, actual, syntheticBreweries: true }));
  assert.deepEqual(actual, expected);
});
test('UT-C14 菜单印刷编号和价量苦度各自保留', (t) => {
  const input = '酒单：\n7. 晴空拉格 - 紫雀酒厂 ¥50 300ml 5% IBU20\n42. 夜潮世涛 - 合成黑鸟酒厂 ¥60 330ml 7% IBU30';
  const actual = parseMenuInput(input).items.map(({ beerName, brewery, menuIndex, price, volumeMl, abv, ibu }) => ({ beerName, brewery, menuIndex, price, volumeMl, abv, ibu }));
  const expected = [
    { beerName: '晴空拉格', brewery: '紫雀酒厂', menuIndex: 7, price: 50, volumeMl: 300, abv: 5, ibu: 20 },
    { beerName: '夜潮世涛', brewery: '合成黑鸟酒厂', menuIndex: 42, price: 60, volumeMl: 330, abv: 7, ibu: 30 },
  ];
  t.diagnostic(JSON.stringify({ id: 'UT-C14', input, expected, actual, syntheticBreweries: true }));
  assert.deepEqual(actual, expected);
});
test('UT-C15 能力问句不被解析为酒款', (t) => {
  const input = '你能做什么'; const actual = parseMenuInput(input);
  t.diagnostic(JSON.stringify({ id: 'UT-C15', input, expected: 'items为空', actual }));
  assert.deepEqual(actual.items, []);
});
test('UT-C16 否定编号不变成正向选择编号', (t) => {
  const input = '不要菜单第7款'; const actual = parseOrdinalReference(input);
  t.diagnostic(JSON.stringify({ id: 'UT-C16', input, expected: null, actual }));
  assert.equal(actual, null);
});
test('UT-C17 明确的复合中文序号按印刷编号解析', (t) => {
  const input = '菜单第四十二款'; const actual = parseOrdinalReference(input);
  t.diagnostic(JSON.stringify({ id: 'UT-C17', input, expected: 42, actual }));
  assert.equal(actual, 42);
});
