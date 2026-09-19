#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function parseArgs(argv) {
  const options = { input: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--input requires a file path');
      options.input = value;
    } else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

async function readInput(file) {
  if (file) return readFile(file, 'utf8');
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const unitPrice = (offer) => positive(offer.price) && positive(offer.volumeMl) ? round2(offer.price / offer.volumeMl * 100) : null;

function hardFailures(offer, constraints) {
  const failures = [];
  if (finite(constraints.maxPrice)) {
    if (!positive(offer.price)) failures.push('价格未知，无法确认预算');
    else if (offer.price > constraints.maxPrice) failures.push(`超出预算 ${constraints.maxPrice}`);
  }
  if (finite(constraints.minPrice)) {
    if (!positive(offer.price)) failures.push('价格未知，无法确认预算下限');
    else if (offer.price < constraints.minPrice) failures.push(`低于预算下限 ${constraints.minPrice}`);
  }
  if (finite(constraints.maxAbv)) {
    if (!positive(offer.abv)) failures.push('ABV 未知');
    else if (offer.abv > constraints.maxAbv) failures.push(`ABV 超过 ${constraints.maxAbv}%`);
  }
  if (finite(constraints.minAbv)) {
    if (!positive(offer.abv)) failures.push('ABV 未知');
    else if (offer.abv < constraints.minAbv) failures.push(`ABV 低于 ${constraints.minAbv}%`);
  }
  if (finite(constraints.maxIbu)) {
    if (!finite(offer.ibu) || offer.ibu < 0) failures.push('IBU 未知');
    else if (offer.ibu > constraints.maxIbu) failures.push(`IBU 超过 ${constraints.maxIbu}`);
  }
  if (finite(constraints.minIbu)) {
    if (!finite(offer.ibu) || offer.ibu < 0) failures.push('IBU 未知');
    else if (offer.ibu < constraints.minIbu) failures.push(`IBU 低于 ${constraints.minIbu}`);
  }
  const haystack = normalize(`${offer.name} ${offer.style}`);
  for (const style of constraints.avoidStyles ?? []) {
    if (haystack.includes(normalize(style))) failures.push(`属于排除风格 ${style}`);
  }
  if (constraints.priceGoal === 'unit' && (!positive(offer.price) || !positive(offer.volumeMl))) {
    failures.push('价格或容量未知，无法比较单位价');
  }
  if (constraints.priceGoal === 'total' && !positive(offer.price)) failures.push('价格未知，无法比较总价');
  return [...new Set(failures)];
}

function rankScore(offer, constraints, comparableUnits) {
  let score = 50;
  const reasons = [];
  const rating = finite(offer.rating) && offer.rating > 0 ? offer.rating : null;
  if (rating != null) {
    const count = finite(offer.ratingCount) ? offer.ratingCount : 0;
    const confidence = count >= 1000 ? 1 : count >= 100 ? .9 : count >= 10 ? .8 : .65;
    score += (rating - 3) * 10 * confidence;
    reasons.push(`评分 ${rating}${count ? `（${count} 次）` : '（样本数未知）'}`);
  }
  const haystack = normalize(`${offer.name} ${offer.style}`);
  for (const style of constraints.preferredStyles ?? []) {
    if (haystack.includes(normalize(style))) { score += 12; reasons.push(`符合偏好 ${style}`); }
  }
  if (constraints.notBitter) {
    if (finite(offer.ibu) && offer.ibu >= 0) {
      if (offer.ibu <= 25) { score += 8; reasons.push(`IBU ${offer.ibu}，苦度线索较低`); }
      else if (offer.ibu > 40) { score -= 12; reasons.push(`IBU ${offer.ibu}，可能偏苦`); }
    } else if (/ipa|bitter|imperial|double|triple|西海岸/i.test(haystack)) {
      score -= 6; reasons.push('IBU 未知，风格可能偏苦');
    }
  }
  const unit = unitPrice(offer);
  if ((constraints.priceGoal === 'unit' || constraints.priceGoal === 'balanced') && unit != null && comparableUnits.length > 1) {
    const min = Math.min(...comparableUnits);
    const max = Math.max(...comparableUnits);
    if (max > min) score += (max - unit) / (max - min) * (constraints.priceGoal === 'unit' ? 24 : 8);
    if (unit === min) reasons.push('可比报价中单位价最低');
  }
  if (constraints.priceGoal === 'total' && positive(offer.price)) score -= offer.price / 10;
  return { score: round2(score), reasons };
}

function decide(input) {
  if (!input || !Array.isArray(input.offers)) throw new Error('offers must be an array');
  const constraints = input.constraints ?? {};
  const normalized = input.offers.map((offer, offset) => ({
    index: Number.isInteger(offer.index) && offer.index > 0 ? offer.index : offset + 1,
    name: String(offer.name ?? '').trim() || `Unknown #${offset + 1}`,
    brewery: String(offer.brewery ?? '').trim(),
    style: String(offer.style ?? '').trim(),
    price: positive(offer.price) ? offer.price : null,
    volumeMl: positive(offer.volumeMl) ? offer.volumeMl : null,
    abv: positive(offer.abv) ? offer.abv : null,
    ibu: finite(offer.ibu) && offer.ibu >= 0 ? offer.ibu : null,
    rating: finite(offer.rating) && offer.rating > 0 ? offer.rating : null,
    ratingCount: finite(offer.ratingCount) && offer.ratingCount >= 0 ? offer.ratingCount : null,
    evidence: Array.isArray(offer.evidence) ? offer.evidence : [],
  }));
  const assessed = normalized.map((offer) => ({ ...offer, unitPricePer100ml: unitPrice(offer), failures: hardFailures(offer, constraints) }));
  const eligible = assessed.filter((offer) => offer.failures.length === 0);
  const comparableUnits = eligible.map(unitPrice).filter((value) => value != null);
  let ranked = eligible.map((offer) => ({ ...offer, ...rankScore(offer, constraints, comparableUnits) }));
  ranked.sort((a, b) => {
    if (constraints.priceGoal === 'unit') return (a.unitPricePer100ml ?? Infinity) - (b.unitPricePer100ml ?? Infinity) || b.score - a.score;
    if (constraints.priceGoal === 'total') return (a.price ?? Infinity) - (b.price ?? Infinity) || b.score - a.score;
    return b.score - a.score || a.index - b.index;
  });
  const recommendations = ranked.slice(0, 3);
  const first = recommendations[0];
  const second = recommendations[1];
  const totalPriceDifference = first && second && positive(first.price) && positive(second.price)
    ? round2(second.price - first.price) : null;
  const unitPriceDifference = first?.unitPricePer100ml != null && second?.unitPricePer100ml != null
    ? round2(second.unitPricePer100ml - first.unitPricePer100ml) : null;
  const comparison = first && second && (totalPriceDifference != null || unitPriceDifference != null) ? {
    fromIndex: first.index,
    toIndex: second.index,
    totalPriceDifference,
    unitPriceDifference,
  } : null;
  const unresolved = assessed.filter((offer) => offer.failures.some((failure) => /未知|无法/.test(failure)));
  const balancedWithoutUnitPrice = constraints.priceGoal === 'balanced'
    ? assessed.filter((offer) => offer.failures.length === 0 && offer.unitPricePer100ml == null)
    : [];
  return {
    schemaVersion: '1',
    status: recommendations.length ? (unresolved.length || balancedWithoutUnitPrice.length ? 'partial' : 'completed') : 'needs_clarification',
    currency: input.currency ?? null,
    recommendations,
    excluded: assessed.filter((offer) => offer.failures.length > 0),
    comparison,
    warnings: [
      ...(input.currency ? [] : ['币种未知；价格只按菜单中的同一标记比较']),
      ...(unresolved.length ? [`${unresolved.length} 个报价因字段未知，未作为确认符合项`] : []),
      ...(balancedWithoutUnitPrice.length ? [`${balancedWithoutUnitPrice.length} 个报价缺少价格或容量，仍可按口味与证据判断，但未参与单位价比较`] : []),
      '单位价只描述本菜单中的价量关系，不证明品质或市场最低价',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/decide-menu.mjs [--input menu.json]\nReads JSON from stdin when --input is omitted.');
    return;
  }
  const raw = await readInput(args.input);
  if (!raw.trim()) throw new Error('decision input is empty');
  console.log(JSON.stringify(decide(JSON.parse(raw)), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', error: error.message }));
  process.exitCode = 1;
});
