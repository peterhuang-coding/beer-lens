import type { PickResult, ScoredCandidate } from "./types";

/**
 * Build a Chinese recommendation reply from the four picks.
 *
 * The format mirrors what a knowledgeable beer friend would say verbally.
 */
export function buildRecommendationReply(
  picks: PickResult,
  candidates: ScoredCandidate[],
): string {
  const index = new Map<string, ScoredCandidate>();
  for (const c of candidates) {
    index.set(c.candidateId, c);
  }

  const top = index.get(picks.topPick.candidateId);
  const safe = index.get(picks.safePick.candidateId);
  const explore = index.get(picks.explorePick.candidateId);
  const avoid = index.get(picks.avoidOrCaution.candidateId);

  const topName = top?.displayName || "暂无";
  const safeName = safe?.displayName || "暂无";
  const exploreName = explore?.displayName || "暂无";
  const avoidName = avoid?.displayName || "暂无";

  return [
    "我会这样点：",
    "",
    `1. ${topName} - ${picks.topPick.reason}`,
    `2. ${safeName} - ${picks.safePick.reason}`,
    `3. ${exploreName} - ${picks.explorePick.reason}`,
    "",
    `最稳：${safeName}`,
    `最值得尝新：${exploreName}`,
    `我会先跳过：${avoidName}`,
    "",
    `如果只能喝一杯，选 ${topName}。`,
  ].join("\n");
}
