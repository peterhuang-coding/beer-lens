import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';
import { extractConstraints } from '../lib/beer-agent/recommendation/constraints.ts';
import type { BeerCandidate } from '../lib/beer-agent/types.ts';

const candidate = (name: string, abv: number): BeerCandidate => ({ candidateId: name, menuIndex: 0, displayName: name, brewery: 'Monkish', style: 'IPA', abv, price: null, volumeMl: null, untappdScore: null, untappdRatingCount: null, hops: [], worthScore: 0, fitScore: 0, reason: '', riskFlags: [], evidence: [{ source: 'manual_user_input', confidence: 1, summary: '冻结参考答案可见字段的手工模块输入' }] });
test('UT-I12 冻结ABV数值限制决策且不补造评分', (t) => {
  const input = { request: 'ABV最多8%', rows: [{ name: 'Thor Pour', abv: 8 }, { name: "Still TIPA'in", abv: 10 }] };
  const result = recommendFromCandidates(input.rows.map(c => candidate(c.name, c.abv)), null, extractConstraints(input.request), false, input.request);
  const actual = { topPick: result.picks.topPick.candidateId, ratings: result.candidates.map(c => c.untappdScore) };
  const expected = { topPick: 'Thor Pour', ratings: [null, null] };
  t.diagnostic(JSON.stringify({ id: 'UT-I12', images: ['IMG-N001', 'IMG-N012'], input, expected, actual, realVqa: false }));
  assert.deepEqual(actual, expected);
});
test('UT-I13 容量未知时说明缺口并不给出满足容量的首选', (t) => {
  const input = { name: 'West Coast Aroma', volumeMl: null, request: '只要473ml' };
  const result = recommendFromCandidates([candidate(input.name, 0)], null, extractConstraints(input.request), false, input.request);
  const actual = { topPick: result.picks.topPick.candidateId, reply: result.reply };
  const expected = { topPick: '', replyContains: ['容量', '暂不推荐', '补充'] };
  t.diagnostic(JSON.stringify({ id: 'UT-I13', image: 'IMG-N002', input, expected, actual, realVqa: false }));
  assert.equal(actual.topPick, '');
  for (const text of expected.replyContains) assert.ok(actual.reply.includes(text));
});
