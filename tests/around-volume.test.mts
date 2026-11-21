import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConstraints, mergeConstraints, constraintFailures } from '../lib/beer-agent/recommendation/constraints.ts';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';
import type { BeerCandidate } from '../lib/beer-agent/types.ts';

const c = (id: string, index: number, price: number | null, volumeMl: number | null, extra: Partial<BeerCandidate> = {}): BeerCandidate => ({
  candidateId: id, menuIndex: index, displayName: id, brewery: 'Fixture', style: 'Lager',
  abv: 5, price, volumeMl, hops: [], worthScore: 0, fitScore: 0, riskFlags: [], reason: '', evidence: [], ...extra,
});
const run = (rows: BeerCandidate[], q: string) => recommendFromCandidates(rows, null, extractConstraints(q), false, q);

test('around-volume suffixes keep the numeric anchor instead of volumeMl:any', () => {
  for (const q of ['只想喝300ml左右的', '只想喝300ml附近', '300ml上下', '300ml左右']) {
    assert.deepEqual(extractConstraints(q), ['aroundVolumeMl:300'], q);
  }
});

test('around-volume prefixes keep the numeric anchor', () => {
  for (const q of ['约300ml', '近似300ml', '接近300ml', '只想喝约300ml', '容量约为300ml']) {
    assert.deepEqual(extractConstraints(q), ['aroundVolumeMl:300'], q);
  }
});

test('explicit relax language is still the only path to volumeMl:any', () => {
  for (const q of ['容量不限', '不限容量', '两种容量都接受', '这两种容量都可以']) {
    assert.deepEqual(extractConstraints(q), ['volumeMl:any'], q);
  }
});

test('exact/min/max volume parsing is unchanged', () => {
  assert.deepEqual(extractConstraints('只要300ml'), ['volumeMl:300']);
  assert.deepEqual(extractConstraints('只想喝300ml'), ['volumeMl:300']);
  assert.deepEqual(extractConstraints('容量最多300ml'), ['maxVolumeMl:300']);
  assert.deepEqual(extractConstraints('至少300ml'), ['minVolumeMl:300']);
  assert.deepEqual(extractConstraints('300ml左右，预算50元').sort(), ['aroundVolumeMl:300', 'maxPrice:50']);
});

test('budget updates preserve the around anchor; same-family requests replace it', () => {
  assert.deepEqual(mergeConstraints(extractConstraints('只想喝300ml左右'), extractConstraints('预算80元')), ['aroundVolumeMl:300', 'maxPrice:80']);
  assert.deepEqual(mergeConstraints(extractConstraints('只想喝300ml左右'), extractConstraints('只要500ml')), ['volumeMl:500']);
  assert.deepEqual(mergeConstraints(extractConstraints('容量不限'), extractConstraints('300ml附近')), ['aroundVolumeMl:300']);
});

test('around volume confirms only the labeled N ml serving, never unknown or other sizes', () => {
  const limits = ['aroundVolumeMl:300'];
  assert.deepEqual(constraintFailures({ displayName: '合成晴空拉格', style: 'Lager', price: 50, volumeMl: 300, abv: 5, ibu: 20, currency: 'CNY' }, limits), []);
  assert.ok(constraintFailures({ displayName: '大杯拉格', style: 'Lager', volumeMl: 500 }, limits).some(r => r.includes('容量')));
  assert.ok(constraintFailures({ displayName: '未知杯拉格', style: 'Lager', volumeMl: null }, limits).some(r => r.includes('未知')));
});

test('ordinary recommendation filters on the labeled 300 ml serving and says so', () => {
  const r = run([c('small', 1, 50, 300), c('large', 2, 55, 500)], '只想喝300ml左右的');
  assert.equal(r.picks.topPick.candidateId, 'small');
  assert.match(r.reply, /先按酒单标出的\s*300\s*ml\s*筛选/);
  assert.equal(r.candidates.length, 2);
  const large = r.candidates.find(x => x.candidateId === 'large')!;
  assert.ok(large.riskFlags.includes('容量不符合要求'));
});

test('no labeled 300 ml serving asks which servings are visible and keeps the facts', () => {
  const r = run([c('mid', 1, 50, 425), c('large', 2, 55, 500)], '只想喝300ml附近');
  assert.equal(r.picks.topPick.candidateId, '');
  assert.match(r.reply, /没有[\s\S]*300\s*ml/);
  assert.match(r.reply, /425/);
  assert.match(r.reply, /500/);
  assert.match(r.reply, /实际可见/);
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every(x => x.riskFlags.includes('容量不符合要求')));
});

test('all-unknown servings cannot match around volume', () => {
  const r = run([c('a', 1, 50, null), c('b', 2, 55, null)], '约300ml');
  assert.equal(r.picks.topPick.candidateId, '');
  assert.match(r.reply, /未知/);
  assert.match(r.reply, /杯型/);
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every(x => x.riskFlags.includes('容量未知，无法确认是否符合要求')));
});

test('missing serving question coexists with other hard-constraint failures', () => {
  const r = run([c('mid', 1, 90, 425), c('large', 2, 95, 500)], '预算80，只想喝300ml左右');
  assert.equal(r.picks.topPick.candidateId, '');
  assert.match(r.reply, /实际可见/);
  for (const id of ['mid', 'large']) {
    const x = r.candidates.find(c => c.candidateId === id)!;
    assert.ok(x.riskFlags.includes('超出预算 ¥80'));
    assert.ok(x.riskFlags.includes('容量不符合要求'));
  }
});

test('when the 300 ml cup exists but fails budget, no serving question is raised', () => {
  const r = run([c('small', 1, 90, 300)], '预算80，只想喝300ml左右');
  assert.equal(r.picks.topPick.candidateId, '');
  assert.doesNotMatch(r.reply, /实际可见/);
  assert.match(r.reply, /没有[\s\S]*符合|调整/);
  const x = r.candidates[0];
  assert.ok(x.riskFlags.includes('超出预算 ¥80'));
  assert.ok(!x.riskFlags.includes('容量不符合要求'));
});

test('explicit two-offer comparison keeps both facts and prefers the closer serving', () => {
  const r = run([c('A', 3, 85, 425), { ...c('B', 18, 85, 300), abv: 11.5 }], '只比较第3号和第18号，两种都接受，只想喝300ml左右，比较单位价并解释取舍');
  assert.equal(r.picks.topPick.candidateId, 'B');
  assert.match(r.reply, /28\.33/);
  assert.match(r.reply, /20\.00/);
  assert.match(r.reply, /11\.5/);
});
