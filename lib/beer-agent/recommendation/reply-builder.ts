import type { PickResult, ScoredCandidate } from "./types";
import { formatOffer, pricePer100ml } from './price-comparison.ts';

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function hasKnownAbv(c: ScoredCandidate): boolean {
  return typeof c.abv === "number" && Number.isFinite(c.abv) && c.abv > 0;
}

/** A rating counts only as a real score with a non-zero rating AND count. */
function hasUsableRating(c: ScoredCandidate): boolean {
  return (
    typeof c.rating === "number" &&
    Number.isFinite(c.rating) &&
    c.rating > 0 &&
    typeof c.ratingsCount === "number" &&
    c.ratingsCount > 0
  );
}

function isUnknownStyle(c: ScoredCandidate): boolean {
  return !c.style || !c.style.trim();
}

/** Pull the current-catalog venue_site evidence (URL + snapshot date), if any. */
function venueAttribution(c: ScoredCandidate): { url: string | null; date: string | null } {
  const venue = (c.evidence ?? []).find((e) => e && e.source === "venue_site");
  const summary = venue?.summary ?? "";
  const url = summary.match(/https?:\/\/[^\s，；、）)」』\]]+/)?.[0] ?? null;
  const date = summary.match(/(?:抓取于|快照于|更新于)?\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return { url, date };
}

/**
 * Sparse singleton reply (e.g. a real image that grounded exactly one beer for
 * which style, description and rating are all unknown). It states identity and
 * verified facts, says explicitly that flavor cannot be inferred from a name,
 * and asks at most one helpful question. It never crowns the beer a safe pick,
 * never dumps internal flags (event_id / rating_usable / missing_*).
 */
function buildSparseSingletonReply(c: ScoredCandidate, name: string): string {
  const lines: string[] = [
    `已识别：${name}${c.brewery ? `（酒厂 ${c.brewery}）` : ""}。`,
  ];

  const { url, date } = venueAttribution(c);
  const sourceTail = url ? `（来源：${url}${date ? `，目录快照 ${date}` : ""}）` : "";
  if (hasKnownAbv(c)) {
    lines.push("", `当前资料：ABV ${formatPercent(c.abv)}%${sourceTail}。`);
  } else if (url) {
    lines.push("", `活动目录来源：${url}${date ? `（目录快照 ${date}）` : ""}。`);
  }

  const missing = ["风格与风味描述", "Untappd 评分"];
  if (!hasKnownAbv(c)) missing.unshift("ABV");
  lines.push(
    "",
    `${missing.join("、")}资料不足，不能仅凭酒名判断口味或是否适合你。`,
  );
  const offer = formatOffer(c);
  if (offer) lines.push("", `图中报价：${offer}。`);
  if (c.riskFlags.some(flag => /ABV.*(?:不一致|冲突)|abv_database_disagreement/i.test(flag))) lines.push("酒精度来源存在分歧，需现场确认。");
  lines.push("", c.price != null && c.volumeMl != null ? "可以补一张酒款介绍，确认风味后再判断是否适合你。" : "把菜单上的价格和容量发我，我再帮你判断值不值得点。");
  return lines.join("\n");
}

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

  const label = (c: ScoredCandidate | undefined) => {
    if (!c) return "暂无";
    const ambiguous = candidates.some(other => other.candidateId !== c.candidateId && other.displayName.toLowerCase() === c.displayName.toLowerCase() && other.brewery !== c.brewery);
    return ambiguous && c.brewery ? `${c.displayName}（${c.brewery}）` : c.displayName;
  };
  const topName = label(top);
  const safeName = label(safe);
  const exploreName = label(explore);
  const avoidName = label(avoid);

  // Singleton + unknown style + no valid rating: no basis exists for ranking
  // language ("最稳 / 只能喝一杯") — answer with verified facts and honesty.
  const sparseSingleton =
    candidates.length === 1 &&
    top !== undefined &&
    isUnknownStyle(top) &&
    !hasUsableRating(top);
  if (sparseSingleton && top) {
    return buildSparseSingletonReply(top, topName);
  }

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

  // Concise verified-fact line for the top pick (style/ABV only; flavor is
  // never invented from a name). Ranking language still drives the list below.
  if (top) {
    const topFacts: string[] = [];
    const topStyle = top.style?.trim();
    if (topStyle) topFacts.push(`风格 ${topStyle}`);
    if (hasKnownAbv(top)) topFacts.push(`ABV ${formatPercent(top.abv)}%`);
    if (topFacts.length > 0) {
      lines.push("", `已知：${topName} · ${topFacts.join("，")}。`);
    }
  }

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
    lines.push(`${seen.size}. ${label(role.candidate)}${offer ? ` · ${offer}` : " · 价格/容量待确认"} - ${role.reason}`);
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
    lines.push('', `价量对比：${label(alternative)} 相对 ${label(top)}，${totalText}${unitText}。`);
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
