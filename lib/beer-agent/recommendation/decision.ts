import type { BeerCandidate } from '../types.ts';
import type { ProfileMemory } from '../memory/profile.ts';
import { constraintFailures } from './constraints.ts';
import { scoreCandidates } from './scoring.ts';
import { selectPicks } from './pick-selector.ts';
import { purchaseScope, purchaseDecision } from './purchase.ts';
import { buildRecommendationReply } from './reply-builder.ts';

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
  const failures = new Map(scored.map(c=>[c.candidateId, constraintFailures(c,constraints)]));
  let eligible = scope.rows.filter(c=>!failures.get(c.candidateId)?.length);
  const bitter = /ipa|bitter|double|triple|印度|西海岸/i;
  if (constraints.includes('不苦') && !constraints.includes('IPA')) {
    const approachable = eligible.filter(c=>c.style && !bitter.test(c.style));
    if (approachable.length) eligible=approachable;
  }
  const purchase = purchaseDecision(eligible, requestText, scope.explicit);
  const picks = scope.error ? selectPicks([]) : purchase?.picks ?? selectPicks(eligible);
  const reply = scope.error ?? purchase?.reply ?? (eligible.length ? buildRecommendationReply(picks,eligible)
    : scored.length ? '酒单上没有可以确认符合当前预算、风格或酒精度要求的酒，暂不推荐。可以调整要求，或补充缺失的价格/酒精度。'
      : '没有识别到可确认的酒款，请补充清晰酒单或具体酒名。');
  return {
    reply,picks,
    candidates: scored.map(c=>({
      ...c, hops:c.hops??[], evidence:c.evidence??[], untappdScore:c.rating??null, untappdRatingCount:c.ratingsCount??null,
      riskFlags:[...new Set([...c.riskFlags,...(failures.get(c.candidateId)??[])])],
    } as BeerCandidate)),
  };
}
