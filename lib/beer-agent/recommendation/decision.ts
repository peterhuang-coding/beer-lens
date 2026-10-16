import type { BeerCandidate } from '../types.ts';
import type { ProfileMemory } from '../memory/profile.ts';
import { constraintFailures } from './constraints.ts';
import { scoreCandidates } from './scoring.ts';
import { selectPicks } from './pick-selector.ts';
import { purchaseScope, purchaseDecision, offerText } from './purchase.ts';
import { buildRecommendationReply } from './reply-builder.ts';
import { applyPricePreference, strictPricePreferenceId } from './price-comparison.ts';
import type { ScoredCandidate } from './types.ts';

/** One decision path for image, text and follow-ups. Keep menu facts; constrain picks. */
export function recommendFromCandidates(candidates: BeerCandidate[], profile: ProfileMemory|null, constraints: string[], memoryEnabled: boolean, requestText = "") {
  const unique = new Map<string, BeerCandidate>();
  for (const c of candidates) {
    if (/sparkling water|probiotic drink|气泡水|乳酸饮|乳饮料/i.test(`${c.style} ${c.displayName} ${c.evidence?.filter(e=>e.source==='ocr').map(e=>e.summary).join(' ')??''}`)) continue;
    // Entity/offer deduplication is performed during assembly, where raw serving exists.
    const key = c.candidateId;
    if (!unique.has(key)) unique.set(key,c);
  }
  const scored = scoreCandidates([...unique.values()].map(c=>({...c,sourceRiskFlags:c.sourceRiskFlags??c.riskFlags,riskFlags:c.sourceRiskFlags??c.riskFlags,price:c.price??null,volumeMl:c.volumeMl??null,rating:c.untappdScore??null,ratingsCount:c.untappdRatingCount??null})),profile,constraints,memoryEnabled);
  const scope = purchaseScope(scored, requestText);
  // Every recommendation — ordinary or an explicit named-offer comparison —
  // retains all current/stored hard constraints, including aroundVolumeMl. The
  // token is never stripped on scope.explicit: comparisons still show excluded
  // offers as facts, but their exclusion reasons and the picks stay constrained.
  const failures = new Map(scored.map(c=>[c.candidateId, constraintFailures(c,requestText ? constraints.filter(x=>!x.startsWith('priceGoal:')) : constraints)]));
  let eligible = scope.rows.filter(c=>!failures.get(c.candidateId)?.length);
  const bitter = /ipa|bitter|double|triple|印度|西海岸/i;
  if (constraints.includes('不苦') && !constraints.includes('IPA')) {
    const approachable = eligible.filter(c=>c.style && !bitter.test(c.style));
    if (approachable.length) eligible=approachable;
  }
  eligible = applyPricePreference(eligible,constraints);
  const purchase = purchaseDecision(eligible, requestText, scope.explicit);
  const picks = scope.error ? selectPicks([]) : purchase?.picks ?? selectPicks(eligible,strictPricePreferenceId(eligible,constraints));
  const eligibleById = new Map(eligible.map(candidate=>[candidate.candidateId,candidate]));
  let reply = scope.error ?? purchase?.reply ?? (eligible.length ? buildRecommendationReply(picks,eligible)
    : scored.length ? '酒单上没有可以确认符合当前预算、容量、风格、苦度或酒精度要求的酒，暂不推荐。可以调整要求，或补充缺失的价格、容量、IBU 或酒精度。'
      : '没有识别到可确认的酒款，请补充清晰酒单或具体酒名。');
  // An explicit comparison may show every named offer with its price/volume/
  // unit-price facts; offers failing a hard constraint are labelled with the
  // reason and never appear among the picks.
  const excluded = !scope.error && scope.explicit
    ? scope.rows.filter(c=>(failures.get(c.candidateId)?.length ?? 0) > 0) : [];
  const factLine = (c: ScoredCandidate) => `第${c.menuIndex||'?'}号 ${c.displayName}：${offerText(c)}${c.abv>0?`；ABV ${c.abv}%`:''}`;
  const excludedLine = (c: ScoredCandidate) => `${factLine(c)}（未纳入推荐：${(failures.get(c.candidateId)??[]).join('、')}）。`;
  const excludedSection = excluded.map(excludedLine).join('\n');
  // Conservative around-volume handling: only the labeled N ml serving is
  // confirmed. If no such serving exists among the relevant offers, state the
  // actual sizes and ask which servings are visible; never default to a larger
  // cup or treat “约 N ml” as unlimited. Unknown volume cannot match.
  const aroundToken = constraints.find(c=>c.startsWith('aroundVolumeMl:'));
  let aroundClarification: string | null = null;
  if (!scope.error && aroundToken && !eligible.length) {
    const n = Number(aroundToken.split(':')[1]);
    if (scope.explicit) {
      if (scope.rows.length && !scope.rows.some(c=>c.volumeMl === n)) {
        const known = [...new Set(scope.rows.map(c=>c.volumeMl).filter((v): v is number => v != null && v > 0))];
        aroundClarification = known.length
          ? `这次比较的酒款都不能确认符合约 ${n} ml 的当前要求。\n${scope.rows.map(excludedLine).join('\n')}\n比较对象标出的杯型里没有 ${n} ml（当前标出：${known.map(v=>`${v}ml`).join('、')}）。约 ${n} ml 不等于不限容量，也不能默认换成大杯；请确认图上实际可见的是哪个杯型，或明确说“容量不限”再放宽。`
          : `这次比较的酒款容量都未标出，无法确认是否符合约 ${n} ml 的要求（未知容量不能当匹配）。\n${scope.rows.map(excludedLine).join('\n')}\n请说明图上实际可见的杯型，或明确说“容量不限”再放宽。`;
      }
    } else if (scored.length && !scored.some(c=>c.volumeMl === n)) {
      const known = [...new Set(scored.map(c=>c.volumeMl).filter((v): v is number => v != null && v > 0))];
      aroundClarification = known.length
        ? `酒单标出的杯型里没有 ${n} ml（当前标出：${known.map(v=>`${v}ml`).join('、')}）。约 ${n} ml 不等于不限容量，也不能默认换成大杯；请确认图上实际可见的是哪个杯型，或明确说“容量不限”再放宽。`
        : `酒单上的容量都未标出，无法确认是否符合约 ${n} ml 的要求（未知容量不能当匹配）。请说明图上实际可见的杯型，或明确说“容量不限”再放宽。`;
    }
  }
  if (aroundClarification) reply = aroundClarification;
  else if (excludedSection) reply = `${excludedSection}\n${reply}`;
  if (!scope.error && aroundToken && eligible.length && !scope.explicit) {
    reply = `先按酒单标出的 ${Number(aroundToken.split(':')[1])} ml 筛选。\n${reply}`;
  }
  return {
    reply,picks,
    candidates: scored.map(original=>{
      const c=eligibleById.get(original.candidateId)??original;
      return ({
      ...c, hops:c.hops??[], evidence:c.evidence??[], untappdScore:c.rating??null, untappdRatingCount:c.ratingsCount??null,
      riskFlags:[...new Set([...c.riskFlags,...(failures.get(c.candidateId)??[])])],
      } as BeerCandidate);
    }),
  };
}
