import type { ScoredCandidate, PickResult } from "./types";

/**
 * Style keywords considered "safe" / approachable for most drinkers.
 * These styles are familiar, widely available, and rarely offensive.
 */
const SAFE_STYLE_KEYWORDS = [
  "pale ale", "pilsner", "pils", "lager", "wheat", "hefe", "weiss",
  "session", "kolsch", "helles", "blonde", "cream ale", "mild",
  "golden ale", "amber ale",
];

function hasSafeStyle(style: string): boolean {
  const lower = style.toLowerCase();
  return SAFE_STYLE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Select four picks from scored candidates:
 *
 * - **topPick**: highest combined (worthScore + fitScore) — "最佳"
 * - **safePick**: highest fitScore among approachable/safe styles — "最稳"
 * - **explorePick**: highest worthScore among risky or low-fit candidates — "尝新"
 * - **avoidOrCaution**: lowest fitScore overall — "谨慎"
 *
 * Falls back to topPick when a rule cannot find a matching candidate.
 */
export function selectPicks(candidates: ScoredCandidate[]): PickResult {
  if (candidates.length === 0) {
    const empty = {
      candidateId: "",
      label: "",
      reason: "暂无候选酒",
      worthScore: 0,
      fitScore: 0,
    };
    return {
      topPick: empty,
      safePick: empty,
      explorePick: empty,
      avoidOrCaution: empty,
    };
  }

  // ── topPick: highest combined score ──
  const sortedByCombined = [...candidates].sort(
    (a, b) => b.worthScore + b.fitScore - (a.worthScore + a.fitScore),
  );
  const topPick = sortedByCombined[0];

  // ── safePick: highest fitScore among safe styles ──
  const safeStyleCandidates = candidates.filter((c) =>
    hasSafeStyle(c.style),
  );
  const safePick =
    safeStyleCandidates.length > 0
      ? safeStyleCandidates.sort((a, b) => b.fitScore - a.fitScore)[0]
      : topPick;

  // ── explorePick: highest worthScore among risky / low-fit candidates ──
  const exploreCandidates = candidates.filter(
    (c) => c.riskFlags.length > 0 || c.fitScore < 65,
  );
  const explorePick =
    exploreCandidates.length > 0
      ? exploreCandidates.sort((a, b) => b.worthScore - a.worthScore)[0]
      : topPick;

  // ── avoidOrCaution: lowest fitScore overall ──
  const sortedByFit = [...candidates].sort(
    (a, b) => a.fitScore - b.fitScore,
  );
  const avoidOrCaution = sortedByFit[0];

  return {
    topPick: toPickItem(topPick, "最佳"),
    safePick: toPickItem(safePick, "最稳"),
    explorePick: toPickItem(explorePick, "尝新"),
    avoidOrCaution: toPickItem(avoidOrCaution, "谨慎"),
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
