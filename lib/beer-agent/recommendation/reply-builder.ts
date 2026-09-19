import type { PickResult, ScoredCandidate } from "./types";
import { formatOffer, pricePer100ml } from './price-comparison.ts';

/**
 * Build a Chinese recommendation reply from the four picks.
 *
 * Uses structured reasons (objective/personal/risk) when available,
 * and explicitly flags data-missing candidates. When the whole menu
 * has no rating data, adds an honesty note and omits the "我会先跳过"
 * line when there is no basis for one (avoidOrCaution empty).
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

  const isDataMissing = (c: ScoredCandidate) =>
    c.riskFlags?.includes("无评分数据") || c.riskFlags?.includes("信息不足");

  // Check if any candidate is data-missing
  const hasDataMissing = candidates.some(isDataMissing);
  const allDataMissing =
    candidates.length > 0 && candidates.every(isDataMissing);

  // Build structured reason lines for a pick
  function reasonLine(candidate: ScoredCandidate | undefined, fallbackReason: string): string {
    if (!candidate) return fallbackReason;

    const parts: string[] = [];

    // Objective info always first
    if (candidate.objectiveReasons && candidate.objectiveReasons.length > 0) {
      parts.push(candidate.objectiveReasons.join("，"));
    }
    // Personal reasons second
    if (candidate.personalReasons && candidate.personalReasons.length > 0) {
      parts.push(candidate.personalReasons.join("，"));
    }
    // Risks last
    if (candidate.riskReasons && candidate.riskReasons.length > 0) {
      parts.push(candidate.riskReasons.join("，"));
    }

    return parts.length > 0 ? parts.join("；") : fallbackReason;
  }

  // Build caution note if data is missing (deduped, capped)
  let cautionNote = "";
  if (hasDataMissing) {
    const missingNames = [
      ...new Set(candidates.filter(isDataMissing).map((c) => c.displayName)),
    ];
    const shown = missingNames.slice(0, 8);
    const suffix =
      missingNames.length > shown.length ? ` 等${missingNames.length}款` : "";
    cautionNote = `\n⚠️ ${shown.join("、")}${suffix} 数据不足，谨慎尝试。`;
  }

  const topReason = reasonLine(top, picks.topPick.reason);
  const safeReason = reasonLine(safe, picks.safePick.reason);
  const exploreReason = reasonLine(explore, picks.explorePick.reason);
  const avoidReason = reasonLine(avoid, picks.avoidOrCaution.reason);

  // If top pick has risk flags, add a qualifier
  const topRiskFlags = top?.riskFlags ?? [];
  const topHasSignificantRisk = topRiskFlags.some(
    (f) => f.includes("高酒精") || f.includes("样本") || f.includes("无评分") || f.includes("信息不足")
  );
  const topQualifier = topHasSignificantRisk ? "（有风险，见下方）" : "";

  const lines: string[] = ["我会这样点："];
  if (allDataMissing) {
    lines.push(
      "",
      "（这批酒都没有评分数据，以下仅按风格粗略分档，别全信我）",
    );
  }
  const roles = [
    { candidate: top, reason: topReason + topQualifier },
    { candidate: safe, reason: safeReason },
    { candidate: explore, reason: exploreReason },
  ];
  const seen = new Set<string>();
  lines.push("");
  for (const role of roles) {
    if (!role.candidate || seen.has(role.candidate.candidateId)) continue;
    seen.add(role.candidate.candidateId);
    const offer = formatOffer(role.candidate);
    lines.push(`${seen.size}. ${role.candidate.displayName}${offer ? ` · ${offer}` : " · 价格/容量待确认"} - ${role.reason}`);
  }
  const alternative = [safe, explore, ...candidates].find((candidate) => candidate && candidate.candidateId !== top?.candidateId);
  if (top && alternative && top.price != null && alternative.price != null) {
    const totalDelta = alternative.price - top.price;
    const totalText = totalDelta === 0
      ? '单次购买总价相同'
      : `单次购买${totalDelta > 0 ? `多花 ¥${formatDelta(totalDelta)}` : `少花 ¥${formatDelta(-totalDelta)}`}`;
    const topUnit = pricePer100ml(top);
    const alternativeUnit = pricePer100ml(alternative);
    const unitText = topUnit != null && alternativeUnit != null
      ? `；单位价${alternativeUnit === topUnit ? '相同' : alternativeUnit > topUnit ? `高约 ¥${formatDelta(alternativeUnit - topUnit)}/100ml` : `低约 ¥${formatDelta(topUnit - alternativeUnit)}/100ml`}`
      : '';
    lines.push('', `价量对比：${alternative.displayName} 相对 ${top.displayName}，${totalText}${unitText}。`);
  }
  lines.push("", `最稳：${safeName}`);
  if (explore && explore.candidateId !== top?.candidateId) lines.push(`最值得尝新：${exploreName}`);
  // No skip line when the whole menu is data-missing — there is no basis
  // for caution beyond the ⚠️ note — or when avoidOrCaution is empty.
  if (picks.avoidOrCaution.candidateId && !allDataMissing) {
    const avoidSuffix =
      avoidReason !== picks.avoidOrCaution.reason ? ` - ${avoidReason}` : "";
    lines.push(`我会先跳过：${avoidName}${avoidSuffix}`);
  }
  lines.push("", `如果只能喝一杯，选 ${topName}。`);
  if (cautionNote) lines.push(cautionNote);

  return lines.join("\n");
}

function formatDelta(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
