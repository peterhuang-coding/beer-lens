import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConstraints, mergeConstraints, constraintFailures } from '../lib/beer-agent/recommendation/constraints.ts';
import { parseMenuInput } from '../lib/beer-agent/recommendation/menu-input.ts';
import { scoreCandidates } from '../lib/beer-agent/recommendation/scoring.ts';
import { selectPicks } from '../lib/beer-agent/recommendation/pick-selector.ts';
import { buildRecommendationReply } from '../lib/beer-agent/recommendation/reply-builder.ts';

const c = (price: number | null, style = 'IPA') => ({ candidateId: String(price), menuIndex: 1, displayName: 'Example', brewery: 'Example', style, abv: 6, price, volumeMl: 330, worthScore: 50, fitScore: 50, riskFlags: [], reason: '' });
test('numeric budgets reject over-budget and unknown prices', () => {
  for (const q of ['预算50元以内', '50 元以下', '不超过50块', '最多50元']) {
    const limits = extractConstraints(q);
    assert.deepEqual(constraintFailures(c(45), limits), []);
    assert.ok(constraintFailures(c(85), limits).length);
    assert.ok(constraintFailures(c(null), limits).length);
  }
});
test('price ranges normalize reversed bounds and include both endpoints', () => {
  for (const q of ['预算 50-80 元', '预算在 ￥80 到 ￥50 元']) {
    const limits = extractConstraints(q);
    assert.deepEqual(limits, ['minPrice:50', 'maxPrice:80']);
    assert.deepEqual(constraintFailures(c(50), limits), []);
    assert.deepEqual(constraintFailures(c(80), limits), []);
    assert.ok(constraintFailures(c(49), limits).length);
    assert.ok(constraintFailures(c(81), limits).length);
  }
});
test('a current budget and style replace the previous request', () => {
  const merged = mergeConstraints(extractConstraints('预算50元，只要拉格'), extractConstraints('改成80元以内的IPA，不要太苦'));
  assert.deepEqual(constraintFailures(c(75), merged), []);
  assert.ok(constraintFailures(c(45, 'Lager'), merged).length);
  assert.ok(merged.includes('不苦'));
});
test('relaxing a price range replaces both previous bounds', () => {
  const merged = mergeConstraints(extractConstraints('预算 50-60 元'), extractConstraints('放宽到80元'));
  assert.deepEqual(merged, ['maxPrice:80']);
  assert.deepEqual(constraintFailures(c(45), merged), []);
  assert.deepEqual(constraintFailures(c(80), merged), []);
  assert.ok(constraintFailures(c(81), merged).length);
});
test('negated style is excluded, while disjunctive requested styles are alternatives', () => {
  assert.ok(constraintFailures(c(30), extractConstraints('不要IPA，来个拉格')).length);
  assert.deepEqual(constraintFailures(c(30, 'Lager'), extractConstraints('IPA或者拉格')), []);
});
test('ABV range and max bound are enforced without accepting unknown strength', () => {
  const limits = extractConstraints('ABV 6-7%');
  assert.deepEqual(constraintFailures(c(30), limits), []);
  assert.ok(constraintFailures({...c(30),abv:8},limits).length);
  assert.ok(constraintFailures({...c(30),abv:0},limits).length);
});
test('explicit IBU bounds are hard constraints with an unknown state', () => {
  const limits = extractConstraints('IBU 不超过 30');
  assert.deepEqual(constraintFailures({...c(30),ibu:20}, limits), []);
  assert.ok(constraintFailures({...c(30),ibu:60}, limits).some(reason=>reason.includes('IBU')));
  assert.ok(constraintFailures({...c(30),ibu:null}, limits).some(reason=>reason.includes('未知')));
});
test('price comparison language is parsed as a request, not a beer name', () => {
  for (const text of ['性价比最高的呢', '按单位价选', '最便宜的是哪个']) {
    assert.equal(parseMenuInput(text).items.length, 0, text);
    assert.ok(extractConstraints(text).some(token=>token.startsWith('priceGoal:')), text);
  }
});
test('having a price alone does not justify saying within budget', () => {
  const rows = scoreCandidates([c(85)], null, ['预算'], false);
  assert.ok(!rows[0].objectiveReasons?.includes('在预算内'));
});
test('new menu fields are not mistaken for preference instructions', () => {
  const parsed = parseMenuInput('帮我看这个酒单并推荐：\n飞拳IPA ¥55 · 330ml · 6.5% ABV\n茉莉花茶拉格 35 500ml\n80 元以内，不苦');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].beerName, '飞拳IPA');
  assert.equal(parsed.items[0].price, 55); assert.equal(parsed.items[0].volumeMl, 330); assert.equal(parsed.items[0].abv, 6.5);
  assert.ok(!extractConstraints(parsed.requestText).includes('IPA'));
  assert.ok(constraintFailures(c(85), extractConstraints(parsed.requestText)).length);
});
test('menu number, ABV and serving are not parsed as prices', () => {
  const parsed = parseMenuInput('酒单：\n1. Pseudo Sue - Toppling Goliath ¥88 473ml 5.8%\n黄河水 45/330 4.8%');
  assert.equal(parsed.items[0].beerName, 'Pseudo Sue'); assert.equal(parsed.items[0].brewery, 'Toppling Goliath');
  assert.equal(parsed.items[0].price, 88); assert.equal(parsed.items[1].price,45); assert.equal(parsed.items[1].volumeMl,330);
});
test('menu IBU is preserved as a candidate fact and never mistaken for price', () => {
  const parsed = parseMenuInput('酒单：\n1. Easy Lager IBU 20 ¥48 330ml 5%\n2. Bitter IPA 60 IBU ¥60 500ml 7%');
  assert.equal(parsed.items[0].ibu, 20); assert.equal(parsed.items[0].price, 48);
  assert.equal(parsed.items[1].ibu, 60); assert.equal(parsed.items[1].price, 60);
  assert.ok(!parsed.items[0].beerName.includes('IBU'));
});
test('a brewery heading applies to adjacent beer rather than becoming a beer', () => {
  const parsed = parseMenuInput('18号酒馆\n跳东湖IPA 48\n京A\n飞拳IPA 55');
  assert.equal(parsed.items.length,2); assert.equal(parsed.items[0].brewery,'18号酒馆'); assert.equal(parsed.items[1].brewery,'京A');
});
test('duplicate roles do not invent multiple beers in the numbered recommendation', () => {
  const rows = [c(50)]; const reply = buildRecommendationReply(selectPicks(rows), rows);
  assert.equal(reply.split('\n').filter(line=>/^\d+\./.test(line)).length,1);
});

test('negated lists exclude every named style',()=>{
 const limits=extractConstraints('不要IPA和拉格');
 assert.ok(constraintFailures(c(30,'IPA'),limits).length);
 assert.ok(constraintFailures(c(30,'Lager'),limits).length);
 assert.deepEqual(constraintFailures(c(30,'Stout'),limits),[]);
});
test('new ABV upper bound replaces both ends of old range',()=>{
 const limits=mergeConstraints(extractConstraints('ABV 6-7%'),extractConstraints('低度'));
 assert.deepEqual(constraintFailures({...c(30),abv:4},limits),[]);
});
test('short and conversational follow-ups are requests, never new beer names',()=>{
 for(const text of ['哪款？','这个','换一款','清爽一点','有便宜的IPA吗','第3个','第 3 个评分','放宽到80元','更苦一点']) assert.equal(parseMenuInput(text).items.length,0,text);
});

test('unknown IBU falls back to style risk while known IBU controls bitterness ranking',()=>{
 const rows=scoreCandidates([
  {...c(60,'IPA'),candidateId:'low',ibu:20},
  {...c(60,'IPA'),candidateId:'high',ibu:70},
  {...c(60,'West Coast IPA'),candidateId:'unknown',ibu:null},
 ],null,['不苦'],false);
 const byId=new Map(rows.map(row=>[row.candidateId,row]));
 assert.ok(byId.get('low')!.fitScore>byId.get('high')!.fitScore);
 assert.ok(byId.get('high')!.riskFlags.includes('苦度偏高'));
 assert.ok(byId.get('unknown')!.riskFlags.includes('可能偏苦'));
 assert.match(byId.get('unknown')!.riskReasons!.join('；'),/IBU 未知/);
});

test('named Chinese requests retain identity and exclusion lines remain instructions',()=>{
 for (const text of ['推荐飞拳IPA','帮我推荐飞拳IPA']) assert.equal(parseMenuInput(text).items[0]?.beerName,'飞拳IPA');
 const parsed=parseMenuInput('酒单：\n飞拳IPA ¥55\n茉莉花茶拉格 ¥35\n不喝IPA');
 assert.equal(parsed.items.length,2);assert.ok(extractConstraints(parsed.requestText).includes('excludeStyle:IPA'));
});

test('English names and named requests with constraints are extracted independently',()=>{
 assert.equal(parseMenuInput('推荐 Flying Fist IPA').items[0]?.beerName,'Flying Fist IPA');
 const parsed=parseMenuInput('推荐飞拳IPA，预算80元以内');
 assert.equal(parsed.items[0]?.beerName,'飞拳IPA');assert.deepEqual(extractConstraints(parsed.requestText),['maxPrice:80']);
});
