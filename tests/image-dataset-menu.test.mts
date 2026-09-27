import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMenuInput } from '../lib/beer-agent/recommendation/menu-input.ts';

// 人工冻结文字的模块输入，非视觉模型输出；不加入来源网页中的未知数值。
const cases = [
  { id: 'UT-I01', image: 'IMG-N008', name: 'Monk-Style Proverbs', brewery: 'Monkish' },
  { id: 'UT-I02', image: 'IMG-N009', name: "Just Tryin' to Feel Something", brewery: 'Monkish' },
  { id: 'UT-I03', image: 'IMG-N012', name: "Still TIPA'in", brewery: 'Monkish' },
  { id: 'UT-I04', image: 'IMG-N020', name: 'Woods & Waters', brewery: 'Maine Beer Company' },
  { id: 'UT-I05', image: 'IMG-N021', name: 'MO', brewery: 'Maine Beer Company' },
];
for (const c of cases) {
  test(`${c.id} 冻结酒名 ${c.name} 保留完整身份且不补造价量`, (t) => {
    const input = `${c.name} | ${c.brewery}`;
    const item = parseMenuInput(input).items[0];
    const actual = { name: item?.beerName, brewery: item?.brewery, price: item?.price, volumeMl: item?.volumeMl, abv: item?.abv, ibu: item?.ibu };
    const expected = { name: c.name, brewery: c.brewery, price: null, volumeMl: null, abv: 0, ibu: null };
    t.diagnostic(JSON.stringify({ id: c.id, image: c.image, input, expected, actual, realVqa: false }));
    assert.deepEqual(actual, expected);
  });
}
test('UT-I06 冻结Thor Pour可见ABV不进入价格字段', (t) => {
  const input = 'Thor Pour | Monkish 8.0%'; const item = parseMenuInput(input).items[0];
  const actual = { name: item?.beerName, brewery: item?.brewery, abv: item?.abv, price: item?.price };
  const expected = { name: 'Thor Pour', brewery: 'Monkish', abv: 8, price: null };
  t.diagnostic(JSON.stringify({ id: 'UT-I06', image: 'IMG-N001', input, expected, actual, realVqa: false }));
  assert.deepEqual(actual, expected);
});
