import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseScope, purchaseDecision } from '../lib/beer-agent/recommendation/purchase.ts';
import type { ScoredCandidate } from '../lib/beer-agent/recommendation/types.ts';

const row = (name: string, index: number, price: number | null, volumeMl: number | null): ScoredCandidate => ({ candidateId: name, displayName: name, menuIndex: index, brewery: 'Maine Beer Company', style: 'IPA', abv: 0, price, volumeMl, worthScore: 0, fitScore: 0, riskFlags: [], reason: '' });
test('UT-I10 否定稀疏编号不反向选中被排除的酒', (t) => {
  const input = '不要第7号和第18号，选第11号';
  const actual = purchaseScope([row('Kölsch', 7, 55, 425), row('DONUT SERIES 2.0', 18, 85, 300), row('LA Love', 11, 110, 300)], input);
  const observed = { ids: actual.rows.map(c => c.candidateId), explicit: actual.explicit, error: actual.error ?? null };
  const expected = { ids: ['LA Love'], explicit: true, error: null };
  t.diagnostic(JSON.stringify({ id: 'UT-I10', input, expected, actual: observed, syntheticCombinedMenu: true, realVqa: false }));
  assert.deepEqual(observed, expected);
});
test('UT-I11 Lunch和Dinner新瓶图缺价量时不产生性价比首选', (t) => {
  const input = { names: ['Lunch', 'Dinner'], price: null, volumeMl: null, request: '哪款性价比高' };
  const result = purchaseDecision([row('Lunch', 1, null, null), row('Dinner', 2, null, null)], input.request, false);
  const actual = { topPick: result?.picks.topPick.candidateId, reply: result?.reply };
  const expected = { topPick: '', replyContains: ['价格或容量信息缺失', '评分不能代替价格证据'] };
  t.diagnostic(JSON.stringify({ id: 'UT-I11', images: ['IMG-N015', 'IMG-N022'], input, expected, actual, realVqa: false }));
  assert.equal(actual.topPick, '');
  for (const text of expected.replyContains) assert.ok(actual.reply?.includes(text));
});
