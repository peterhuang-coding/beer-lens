import test from 'node:test';
import {purchaseScope} from '../lib/beer-agent/recommendation/purchase.ts';
import assert from 'node:assert/strict';
import { chineseOrdinal } from '../lib/beer-agent/recommendation/chinese-ordinal.ts';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';
import { extractConstraints } from '../lib/beer-agent/recommendation/constraints.ts';
import type { BeerCandidate } from '../lib/beer-agent/types.ts';

const chineseOrdinalTable = (n: number) => { const digits='零一二三四五六七八九'; return n<10?digits[n]:`${n<20?'':digits[Math.floor(n/10)]}十${n%10?digits[n%10]:''}`; };

const c = (id: string, index: number): BeerCandidate => ({
  candidateId: id,
  menuIndex: index,
  displayName: id,
  brewery: 'Fixture',
  style: 'Lager',
  abv: 5,
  price: 50,
  volumeMl: 500,
  hops: [],
  worthScore: 0,
  fitScore: 0,
  riskFlags: [],
  reason: '',
  evidence: [],
});

const run = (rows: BeerCandidate[], q: string) =>
  recommendFromCandidates(rows, null, extractConstraints(q), false, q);

test('Chinese ordinal helper independently covers every explicit value 1..99', () => {
  for (let n = 1; n <= 99; n += 1) {
    assert.equal(chineseOrdinal(chineseOrdinalTable(n)), n, `table round trip for ${n}`);
  }
});

test('Chinese ordinals require explicit 第...号/款/个/杯 and never use punctuation alone', () => {
  for (const suffix of ['号', '款', '个', '杯'] as const) {
    for (let n = 1; n <= 99; n += 1) {
      const rows = [c('outside', 100), c(`target-${n}`, n)];
      const r = run(rows, `只选第${chineseOrdinalTable(n)}${suffix}`);
      assert.equal(r.picks.topPick.candidateId, `target-${n}`, `第${chineseOrdinalTable(n)}${suffix}`);
      assert.equal(r.picks.safePick.candidateId, '');
    }
  }
});

test('Chinese ordinals use sparse printed menu indices, including reordered and duplicate data', () => {
  const rows = [c('seventy', 70), c('twelve', 12), c('ninety-nine', 99)];
  const q = '只要第十二个和第九十九杯，哪款更划算？';
  const r = run(rows, q);
  assert.deepEqual(
    [r.picks.topPick.candidateId, r.picks.safePick.candidateId].sort(),
    ['ninety-nine', 'twelve'],
  );
  assert.ok(![r.picks.topPick.candidateId, r.picks.safePick.candidateId].includes('seventy'));

  const duplicate = [...rows, c('duplicate-ninety-nine', 99)];
  const ambiguous = run(duplicate, '选第九十九号');
  assert.equal(ambiguous.picks.topPick.candidateId, '');
  assert.match(ambiguous.reply, /确认|澄清/);
});

test('missing Chinese ordinal is clarified without falling back to another number or row', () => {
  const r = run([c('one', 1), c('two', 2)], '只比较第一号和第九十九号，预算50元');
  assert.equal(r.picks.topPick.candidateId, '');
  assert.match(r.reply, /第99号/);
});

test('Arabic references remain unchanged above and below 99', () => {
  const rows = [c('n7', 7), c('n100', 100), c('n101', 101)];
  const hash = run(rows, '比较#100和#101');
  assert.deepEqual([hash.picks.topPick.candidateId, hash.picks.safePick.candidateId].sort(), ['n100', 'n101']);

  const numbered = run(rows, '比较100号和101号');
  assert.deepEqual([numbered.picks.topPick.candidateId, numbered.picks.safePick.candidateId].sort(), ['n100', 'n101']);


});

test('bare numbers, ABV and volume never become printed references', () => {
  const rows=[c('one',1),c('seven',7)];
  for(const q of ['三杯99元，ABV5%，喝300ml', '1.5元100ml', '首选1，备选2']) {
    assert.equal(purchaseScope(rows as any,q).explicit,false,q);
  }
});
test('Chinese grammar rejects malformed numbers',()=>{
 for(const value of ['', '零', '一一', '二十三四', '十十', '零一', '一百']) assert.equal(chineseOrdinal(value),null,value);
 assert.equal(chineseOrdinal('两'),2);
});
