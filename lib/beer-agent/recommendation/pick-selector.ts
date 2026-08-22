import type { ScoredCandidate, PickResult } from "./types";

/**
 * Style keywords considered "safe" / approachable for most drinkers.
 * These styles are familiar, widely available, and rarely offensive.
 * Chinese keywords cover menu OCR output (styles come back in Chinese).
 */
const SAFE_STYLE_KEYWORDS = [
  "pale ale", "pilsner", "pils", "lager", "wheat", "hefe", "weiss",
  "session", "kolsch", "helles", "blonde", "cream ale", "mild",
  "golden ale", "amber ale",
  "拉格", "皮尔森", "皮尔斯", "小麦", "科隆", "金色",
];

function hasSafeStyle(style: string): boolean {
  const lower = style.toLowerCase();
  return SAFE_STYLE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Fit-score gap below which two candidates are treated as "indistinguishable".
 * When topPick is itself a safe style and its fit advantage over the
 * runner-up is within this gap (e.g., whole menu unrated → gap 0), safePick
 * picks the runner-up for diversity; beyond the gap, topPick is clearly the
 * safest choice and safePick repeats it (coincidence = honesty).
 */
const SAFE_DUP_GAP = 15;

/**
 * Highest combined-score candidate not yet picked, or undefined if none.
 */
function firstUnpicked(
  candidates: ScoredCandidate[],
  exclude: Set<string>,
): ScoredCandidate | undefined {
  return [...candidates]
    .sort((a, b) => b.worthScore + b.fitScore - (a.worthScore + a.fitScore))
    .find((c) => !exclude.has(c.candidateId));
}

/**
 * Select four picks from scored candidates:
 *
 * - **topPick**: highest combined (worthScore + fitScore) — "最佳"
 * - **safePick**: highest fitScore among approachable/safe styles — "最稳"
 * - **explorePick**: highest worthScore among risky or low-fit candidates — "尝新"
 * - **avoidOrCaution**: lowest fitScore among remaining candidates — "谨慎"
 *
 * General rule: scores distinguish → role correctness wins (safePick may
 * coincide with topPick when topPick is clearly the safest — coincidence
 * is honesty); scores tie or nearly tie → diversity wins (safePick takes
 * the runner-up safe style, explore/avoid exclude already-picked
 * candidates). When nothing is left, avoidOrCaution gets an empty
 * candidateId and the reply builder omits that line.
 */
export function selectPicks(candidates: ScoredCandidate[]): PickResult {
  const emptyPick = () => ({
    candidateId: "",
    label: "",
    reason: "暂无候选酒",
    worthScore: 0,
    fitScore: 0,
  });

  if (candidates.length === 0) {
    return {
      topPick: emptyPick(),
      safePick: emptyPick(),
      explorePick: emptyPick(),
      avoidOrCaution: emptyPick(),
    };
  }

  const pickedIds = new Set<string>();

  // ── topPick: highest combined score ──
  const topPick = [...candidates].sort(
    (a, b) => b.worthScore + b.fitScore - (a.worthScore + a.fitScore),
  )[0];
  pickedIds.add(topPick.candidateId);

  // ── safePick: highest fitScore among safe styles, excluding topPick;
  //    fall back to topPick when no other safe style exists. When topPick
  //    is itself a safe style, repeat it only if it is clearly safer
  //    (gap > SAFE_DUP_GAP) — otherwise keep the runner-up for diversity. ──
  const safePool = candidates.filter(
    (c) => !pickedIds.has(c.candidateId) && hasSafeStyle(c.style),
  );
  const safePoolBest =
    safePool.length > 0
      ? safePool.sort((a, b) => b.fitScore - a.fitScore)[0]
      : undefined;
  let safePick: ScoredCandidate;
  if (!safePoolBest) {
    safePick = topPick;
  } else if (
    hasSafeStyle(topPick.style) &&
    topPick.fitScore - safePoolBest.fitScore > SAFE_DUP_GAP
  ) {
    safePick = topPick;
  } else {
    safePick = safePoolBest;
  }
  if (safePick !== topPick) pickedIds.add(safePick.candidateId);

  // ── explorePick: highest worthScore among risky / low-fit, excluding
  //    top and safe picks ──
  const explorePool = candidates.filter(
    (c) =>
      !pickedIds.has(c.candidateId) &&
      (c.riskFlags.length > 0 || c.fitScore < 65),
  );
  const explorePick =
    (explorePool.length > 0
      ? explorePool.sort((a, b) => b.worthScore - a.worthScore)[0]
      : undefined) ?? firstUnpicked(candidates, pickedIds);
  if (explorePick) pickedIds.add(explorePick.candidateId);

  // ── avoidOrCaution: lowest fitScore among the remaining candidates ──
  const avoidPool = candidates.filter((c) => !pickedIds.has(c.candidateId));
  const avoidOrCaution =
    avoidPool.length > 0
      ? avoidPool.sort((a, b) => a.fitScore - b.fitScore)[0]
      : undefined;

  return {
    topPick: toPickItem(topPick, "最佳"),
    safePick: toPickItem(safePick ?? topPick, "最稳"),
    explorePick: toPickItem(explorePick ?? topPick, "尝新"),
    avoidOrCaution: avoidOrCaution
      ? toPickItem(avoidOrCaution, "谨慎")
      : emptyPick(),
  };
}

function toPickItem(
  candidate: ScoredCandidate,
  label: string,
): PickResult["topPick"] {
  return {
    candidateId: candidate.candidateId,
    label,
    reason:
      candidate.reason ||
      (label === "谨慎" ? "综合评分较低" : "综合表现适中"),
    worthScore: candidate.worthScore,
    fitScore: candidate.fitScore,
  };
}
