import type { BeerCandidate } from "../types.ts";
import type { Claim } from "../dossier/types.ts";
import { styleIntensity } from "../dossier/style-knowledge.ts";
import { offerText } from "./purchase.ts";
import type { PickResult, ScoredCandidate } from "./types.ts";

const SOURCE_KIND_ZH: Record<string, string> = {
  brewery: "酒厂来源",
  retailer: "零售商来源",
  community: "社区来源",
};

function claimSource(claim: Claim<unknown>): string {
  const kind = SOURCE_KIND_ZH[claim.sourceKind ?? ""] ?? claim.source;
  const date = claim.checkedAt ? `，${claim.checkedAt.slice(0, 10)} 核对` : "";
  const access = claim.access === "web_index_or_cache" ? "，索引/缓存" : "";
  return `${kind}${date}${access}`;
}

function abvText(candidate: ScoredCandidate): string {
  const dossier = candidate.dossier;
  if (!dossier) return candidate.abv > 0 ? `ABV ${candidate.abv}%` : "ABV 未确认";
  const values = [...new Set(dossier.abv.observations.map(claim => claim.value))];
  if (values.length === 0) return "ABV 未确认";
  const display = values.map(value => `${value}%`).join(" / ");
  return `ABV ${display}${dossier.abv.conflicted ? "（来源冲突，并列保留）" : ""}`;
}

function menuNumber(candidate: ScoredCandidate, fallback: number): number {
  return Number.isInteger(candidate.menuIndex) && candidate.menuIndex > 0 ? candidate.menuIndex : fallback;
}

function identityCaveat(candidate: ScoredCandidate): string {
  const status = candidate.dossier?.identity.identityStatus;
  if (status === "version_unresolved") return "；版本未确认，不套用候选版本事实";
  if (status === "batch_unresolved") return "；批次/年份未确认，不套用特定批次事实";
  return "";
}

function knowledgeText(candidate: ScoredCandidate): string {
  const dossier = candidate.dossier;
  if (!dossier) return "款级资料未确认，不推断酒花、原料或具体风味。";
  const facts: string[] = [];
  const claims: Claim<unknown>[] = [];
  const add = (label: string, claim: Claim<string[]> | null) => {
    if (!claim) return;
    facts.push(`${label}${claim.value.join("、")}`);
    claims.push(claim as Claim<unknown>);
  };
  add("款级感官：", dossier.sensory);
  add("酒花：", dossier.hops);
  add("工艺：", dossier.process);
  add("配料：", dossier.ingredients);

  if (dossier.sensory == null) {
    facts.push(`${dossier.styleLayer.label}：${dossier.styleLayer.summary}`);
  }
  if (facts.length === 0) facts.push("款级酒花、原料与感官资料待补，不作配方猜测");
  const provenance = [...new Set(claims.map(claimSource))];
  if (provenance.length > 0) facts.push(`来源：${provenance.join("；")}`);
  return facts.join("；");
}

function pickReason(candidate: ScoredCandidate): string {
  const personal = candidate.personalReasons?.find(reason => reason.trim());
  if (personal) return personal;
  if (candidate.dossier?.sensory || candidate.dossier?.hops) {
    return "有款级风味或酒花资料，便于按口味选择";
  }
  if (candidate.dossier?.styleLayer.style) {
    return `偏好信息有限，先按 ${candidate.dossier.styleLayer.style} 的风格通性给出选择`;
  }
  return "当前只按可确认的菜单信息选择，不宣称质量高低";
}

function pickTradeoff(candidate: ScoredCandidate): string {
  if (candidate.dossier?.abv.conflicted) return "ABV 来源有分歧，先确认再判断强度";
  if (candidate.abv > 10) return "酒精度高，适合靠后小杯慢饮";
  if (/ipa|bitter/i.test(candidate.style) && candidate.ibu == null) return "IBU 未知，不能把风格当成实际苦度保证";
  if (candidate.dossier?.identity.identityStatus.includes("unresolved")) return "身份未决，先核对版本再深入比较";
  return "单位价只作菜单内算术，不代表品质或市场最低价";
}

/** First-turn only: concise picks plus a complete, row-preserving menu reading. */
export function buildSommelierMenuReply(
  candidates: ScoredCandidate[],
  picks: PickResult,
  selectionPool: ScoredCandidate[] = candidates,
): string {
  const byId = new Map(candidates.map(candidate => [candidate.candidateId, candidate]));
  const chosen: ScoredCandidate[] = [];
  const seen = new Set<string>();
  const addPick = (candidate: ScoredCandidate | undefined) => {
    if (!candidate || seen.has(candidate.candidateId)) return;
    seen.add(candidate.candidateId);
    chosen.push(candidate);
  };
  for (const pick of [picks.topPick, picks.safePick, picks.explorePick]) addPick(byId.get(pick.candidateId));
  for (const candidate of [...selectionPool].sort((a, b) =>
    b.worthScore + b.fitScore - (a.worthScore + a.fitScore) || a.menuIndex - b.menuIndex)) {
    if (chosen.length >= Math.min(3, selectionPool.length)) break;
    addPick(candidate);
  }

  const labels = ["首选", "稳妥备选", "探索备选"];
  const pickLines = chosen.slice(0, 3).map((candidate, index) => {
    const number = menuNumber(candidate, candidates.indexOf(candidate) + 1);
    return `${index + 1}. #${number} ${candidate.displayName}（${labels[index]}）：${pickReason(candidate)}；${offerText(candidate)}；取舍：${pickTradeoff(candidate)}。`;
  });
  const rows = candidates.map((candidate, index) => {
    const number = menuNumber(candidate, index + 1);
    const identity = candidate.brewery ? `${candidate.brewery} / ` : "";
    const style = candidate.dossier?.style?.value || candidate.style || "风格未确认";
    const rating = candidate.dossier?.rating
      ? `；评分 ${candidate.dossier.rating.value.score}/5（${candidate.dossier.rating.value.count} 人，${candidate.dossier.rating.checkedAt?.slice(0, 10)} 快照）`
      : "";
    return `#${number} ${identity}${candidate.displayName}｜${style}｜${abvText(candidate)}｜${offerText(candidate)}${rating}${identityCaveat(candidate)}\n${knowledgeText(candidate)}`;
  });
  const ordered = [...candidates].sort((a, b) =>
    styleIntensity(a.dossier?.style?.value ?? a.style) - styleIntensity(b.dossier?.style?.value ?? b.style) ||
    a.abv - b.abv || a.menuIndex - b.menuIndex);
  const order = ordered.map((candidate, index) => `#${menuNumber(candidate, candidates.indexOf(candidate) + 1)}`).join(" → ");

  return [
    chosen.length > 0
      ? `先给你 ${chosen.slice(0, 3).length} 个选择（按当前口味、约束和已确认资料）：`
      : "当前没有可确认符合约束的选择；以下保留整单事实，不强行凑推荐。",
    ...pickLines,
    "",
    `整单解读（共 ${candidates.length} 款，逐款如下）：`,
    ...rows,
    "",
    `品饮顺序：${order}。先清爽/低强度，后高酒精、厚重或甜点化；只是风格建议，可按你的口味调整。`,
    "资料边界：风格通性不等于本款事实；没有可靠评分就不报评分。没有同款、同版本、同消费形式、同币种口径及注明日期的市场报价来源时，不作产地或市场溢价结论。你的口味反馈只用于个人推荐，不会自动成为公共酒款事实。",
  ].join("\n");
}
