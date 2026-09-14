import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const script = path.join(process.cwd(), 'skills/beer-lens/scripts/decide-menu.mjs');

function decide(input: object) {
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('portable skill helper keeps total budget above unit-price preference', () => {
  const result = decide({ currency: 'CNY', constraints: { maxPrice: 50, priceGoal: 'unit' }, offers: [
    { index: 1, name: 'A', price: 48, volumeMl: 330 },
    { index: 2, name: 'B', price: 60, volumeMl: 500 },
  ] });
  assert.equal(result.recommendations[0].index, 1);
  assert.ok(result.excluded.find((offer: { index: number }) => offer.index === 2));
});

test('portable skill helper compares unit price when offers are eligible', () => {
  const result = decide({ currency: 'CNY', constraints: { maxPrice: 80, priceGoal: 'unit' }, offers: [
    { index: 1, name: 'A', price: 60, volumeMl: 300, rating: 4.5, ratingCount: 1000 },
    { index: 2, name: 'B', price: 50, volumeMl: 500, rating: 3.5, ratingCount: 1000 },
  ] });
  assert.equal(result.recommendations[0].index, 2);
  assert.equal(result.recommendations[0].unitPricePer100ml, 10);
  assert.equal(result.comparison.totalPriceDifference, 10);
});

test('portable skill helper keeps unknown IBU out of confirmed results', () => {
  const result = decide({ constraints: { maxIbu: 30 }, offers: [
    { index: 1, name: 'Low', ibu: 20 },
    { index: 2, name: 'High', ibu: 60 },
    { index: 3, name: 'Unknown' },
  ] });
  assert.deepEqual(result.recommendations.map((offer: { index: number }) => offer.index), [1]);
  assert.match(result.excluded.find((offer: { index: number }) => offer.index === 3).failures.join(' '), /未知/);
});

test('portable skill helper enforces lower ABV and IBU bounds', () => {
  const result = decide({ constraints: { minAbv: 6, minIbu: 20 }, offers: [
    { index: 1, name: 'Too Low', abv: 3, ibu: 5, price: 40, volumeMl: 330 },
    { index: 2, name: 'Fits', abv: 7, ibu: 30, price: 50, volumeMl: 330 },
  ] });
  assert.deepEqual(result.recommendations.map((offer: { index: number }) => offer.index), [2]);
  assert.match(result.excluded.find((offer: { index: number }) => offer.index === 1).failures.join(' '), /ABV|IBU/);
});

test('portable skill helper omits monetary comparison unless both prices are known', () => {
  const result = decide({ offers: [
    { index: 1, name: 'Unknown Price' },
    { index: 2, name: 'Known Price', price: 50, volumeMl: 500 },
  ] });
  assert.equal(result.comparison, null);
});

test('portable skill helper excludes unknown price from a lowest-total-price request', () => {
  const result = decide({ constraints: { priceGoal: 'total' }, offers: [
    { index: 1, name: 'Unknown Price' },
    { index: 2, name: 'Known Price', price: 50, volumeMl: 500 },
  ] });
  assert.deepEqual(result.recommendations.map((offer: { index: number }) => offer.index), [2]);
  assert.match(result.excluded[0].failures.join(' '), /总价/);
});

test('portable skill balanced mode keeps candidates with unknown price or serving', () => {
  const result = decide({ constraints: { priceGoal: 'balanced', preferredStyles: ['lager'] }, offers: [
    { index: 1, name: 'Known Lager', style: 'Lager', price: 50, volumeMl: 500 },
    { index: 2, name: 'Draft Lager', style: 'Lager' },
  ] });
  assert.deepEqual(result.recommendations.map((offer: { index: number }) => offer.index).sort(), [1, 2]);
  assert.equal(result.excluded.length, 0);
  assert.ok(result.warnings.some((warning: string) => /仍可按口味与证据判断/.test(warning)));
});

test('portable user skill is independent from repository paths and Untappd login', () => {
  const skill = readFileSync(path.join(process.cwd(), 'skills/beer-lens/SKILL.md'), 'utf8');
  assert.match(skill, /does not require the user to sign in to Untappd/);
  assert.doesNotMatch(skill, /\/ws\/|\/Users\/|\.beer-data/);
  assert.match(skill, /scripts\/decide-menu\.mjs/);
  const readme = readFileSync(path.join(process.cwd(), 'skills/beer-lens/README.md'), 'utf8');
  assert.match(readme, /预算、ABV、IBU/);
  assert.match(readme, /不需要登录 Untappd/);
});
