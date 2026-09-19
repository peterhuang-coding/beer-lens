import type { ScoredCandidate } from './types.ts';

export type PriceGoal = 'unit' | 'compare' | 'total' | null;

export function priceGoalFromConstraints(constraints: string[]): PriceGoal {
  const token = constraints.find((constraint) => constraint.startsWith('priceGoal:'));
  if (token === 'priceGoal:unit') return 'unit';
  if (token === 'priceGoal:compare') return 'compare';
  if (token === 'priceGoal:total') return 'total';
  return null;
}

export function pricePer100ml(candidate: Pick<ScoredCandidate, 'price' | 'volumeMl'>): number | null {
  if (candidate.price == null || candidate.price <= 0 || candidate.volumeMl == null || candidate.volumeMl <= 0) return null;
  return candidate.price / candidate.volumeMl * 100;
}

/**
 * Add a small, menu-relative preference only when the user explicitly asks
 * for price comparison. This is not a universal rating/price score: hard
 * constraints run first, and quality/personal fit remain separate signals.
 */
export function applyPricePreference(candidates: ScoredCandidate[], constraints: string[]): ScoredCandidate[] {
  const goal = priceGoalFromConstraints(constraints);
  if (!goal || candidates.length < 2) return candidates;

  const comparable = candidates
    .map((candidate) => ({
      candidate,
      cost: goal === 'total' ? candidate.price : pricePer100ml(candidate),
    }))
    .filter((entry): entry is { candidate: ScoredCandidate; cost: number } => entry.cost != null && entry.cost > 0)
    .sort((a, b) => a.cost - b.cost);
  if (comparable.length < 2) return candidates;

  const bestId = comparable[0].candidate.candidateId;
  const label = goal === 'total' ? '这几款中单次购买总价最低' : '这几款可比报价中单位价最低';
  return candidates.map((candidate) => {
    if (candidate.candidateId !== bestId) return candidate;
    return {
      ...candidate,
      fitScore: Math.min(100, candidate.fitScore + (goal === 'compare' ? 8 : 12)),
      objectiveReasons: [...(candidate.objectiveReasons ?? []), label],
    };
  });
}

export function strictPricePreferenceId(candidates: ScoredCandidate[], constraints: string[]): string | null {
  const goal = priceGoalFromConstraints(constraints);
  if (goal !== 'unit' && goal !== 'total') return null;
  const comparable = candidates
    .map((candidate) => ({ candidate, cost: goal === 'total' ? candidate.price : pricePer100ml(candidate) }))
    .filter((entry): entry is { candidate: ScoredCandidate; cost: number } => entry.cost != null && entry.cost > 0)
    .sort((a, b) => a.cost - b.cost || (b.candidate.worthScore + b.candidate.fitScore) - (a.candidate.worthScore + a.candidate.fitScore));
  return comparable[0]?.candidate.candidateId ?? null;
}

export function formatOffer(candidate: Pick<ScoredCandidate, 'price' | 'volumeMl'>): string | null {
  if (candidate.price == null || candidate.price <= 0) return null;
  const price = formatNumber(candidate.price);
  if (candidate.volumeMl == null || candidate.volumeMl <= 0) return `¥${price}（容量未知）`;
  const unit = pricePer100ml(candidate);
  return `¥${price} / ${formatNumber(candidate.volumeMl)}ml（约 ¥${formatNumber(unit!)}/100ml）`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
