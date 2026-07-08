import type { ProfileMemory } from "@/lib/beer-agent/memory/profile";
import type { ScoredCandidate } from "./types";

const CRISP_STYLE_KEYWORDS = [
  "pilsner", "pils", "lager", "helles", "kolsch", "wheat", "hefe", "weiss",
  "berliner", "gose", "session", "blonde", "cream ale",
  "pale lager", "leicht", "crisp",
];

const BITTER_STYLE_KEYWORDS = [
  "ipa", "imperial", "double", "triple", "barleywine", "barley wine",
  "bitter", "esb", "strong ale",
];

function hasStyleKeyword(style: string, keywords: string[]): boolean {
  const lower = style.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function isCrispStyle(style: string): boolean {
  return hasStyleKeyword(style, CRISP_STYLE_KEYWORDS);
}

function isBitterStyle(style: string): boolean {
  return hasStyleKeyword(style, BITTER_STYLE_KEYWORDS);
}

/**
 * Rating confidence multiplier based on ratingsCount.
 * Quick scale:
 *   - 0 ratings → 0.6 (lowest confidence)
 *   - 1-10   → 0.7
 *   - 11-50  → 0.8
 *   - 51-200 → 0.9
 *   - 201-1k → 0.95
 *   - 1000+  → 1.0
 */
function ratingConfidence(ratingsCount: number | null | undefined): number {
  if (ratingsCount == null || ratingsCount <= 0) return 0.6;
  if (ratingsCount <= 10) return 0.7;
  if (ratingsCount <= 50) return 0.8;
  if (ratingsCount <= 200) return 0.9;
  if (ratingsCount <= 1000) return 0.95;
  return 1.0;
}

/**
 * Score each candidate with worthScore, fitScore, and structured reasons.
 *
 * worthScore (0–100) measures objective quality:
 *   - Rating * confidence(ratingsCount) as primary signal
 *   - Price/value bonuses (with volume data)
 *   - Risk penalties (missing data, high ABV, low sample size)
 *
 * fitScore (0–100) measures personal preference match:
 *   - Profile style/tag matching (with memory-referencing reasons)
 *   - ABV comfort range
 *   - Constraint keywords (清爽, IPA, 不苦, 拉格)
 *   - Current constraints OVERRIDE long-term profile
 *
 * Reasons are split into three categories:
 *   - objectiveReasons: rating, ratingsCount, price, ABV
 *   - personalReasons: profile/style matching, history
 *   - riskReasons: bitterness risk, high ABV, data missing, low confidence
 */
export function scoreCandidates(
  candidates: ScoredCandidate[],
  profile: ProfileMemory | null,
  constraints: string[],
  memoryEnabled = true,
): ScoredCandidate[] {
  return candidates.map((candidate) => {
    let worthScore: number;
    let fitScore: number;
    const riskFlags: string[] = [];
    const objectiveReasons: string[] = [];
    const personalReasons: string[] = [];
    const riskReasons: string[] = [];

    const styleLower = (candidate.style || "").toLowerCase();
    const nameAndStyle = `${candidate.displayName} ${candidate.style}`.toLowerCase();

    // ══════════════════════════════════════════
    // worthScore — objective quality
    // ══════════════════════════════════════════

    if (candidate.rating != null && candidate.rating > 0) {
      // Base worth from rating, scaled by ratingsCount confidence
      const rawRatingScore = candidate.rating * 20; // 4.0→80, 3.5→70
      const confidence = ratingConfidence(candidate.ratingsCount);
      worthScore = Math.round(rawRatingScore * confidence);

      objectiveReasons.push(`评分${candidate.rating.toFixed(1)}`);
      if (candidate.ratingsCount != null && candidate.ratingsCount > 0) {
        if (candidate.ratingsCount >= 1000) {
          objectiveReasons.push(`${candidate.ratingsCount}+人评分`);
        } else if (candidate.ratingsCount >= 100) {
          objectiveReasons.push(`${candidate.ratingsCount}人评分`);
        }
      } else {
        riskReasons.push("评分样本少，置信度降低");
        riskFlags.push("低样本评分");
      }

      // Penalize low sample count explicitly
      if (candidate.ratingsCount != null && candidate.ratingsCount <= 10) {
        worthScore = Math.max(0, worthScore - 10);
        riskFlags.push("样本<10，评分参考性低");
        if (!riskReasons.includes("评分样本少，置信度降低")) {
          riskReasons.push("评分样本少，置信度降低");
        }
      }
    } else {
      worthScore = 50;
      riskFlags.push("无评分数据");
      riskReasons.push("无评分数据，无法判断质量");
    }

    // Price / volume ratio bonus
    if (candidate.price != null && candidate.volumeMl != null && candidate.volumeMl > 0) {
      const pricePerMl = candidate.price / candidate.volumeMl;
      if (pricePerMl <= 0.01) {
        worthScore = Math.min(100, worthScore + 8);
        objectiveReasons.push(`性价比极高 ¥${candidate.price}/${candidate.volumeMl}ml`);
      } else if (pricePerMl <= 0.015) {
        worthScore = Math.min(100, worthScore + 5);
        objectiveReasons.push("性价比高");
      } else if (pricePerMl <= 0.02) {
        worthScore = Math.min(100, worthScore + 2);
        objectiveReasons.push("价格适中");
      }
    }

    // Risk: missing data — explicit penalty
    let missingDataCount = 0;
    if (!candidate.style || candidate.style.trim() === "") {
      riskFlags.push("风格未知");
      riskReasons.push("啤酒风格未知");
      missingDataCount++;
    }
    if (!candidate.brewery || candidate.brewery.trim() === "") {
      riskFlags.push("酒厂未知");
      riskReasons.push("酒厂信息缺失");
      missingDataCount++;
    }
    if (candidate.abv <= 0) {
      riskFlags.push("酒精度未知");
      missingDataCount++;
    }
    if (missingDataCount > 0) {
      worthScore = Math.max(0, worthScore - missingDataCount * 5);
      if (missingDataCount >= 2) {
        riskFlags.push("信息不足");
        riskReasons.push("数据不足，谨慎尝试");
      }
    }

    // Risk: high ABV — clear tiered penalty
    if (candidate.abv > 12) {
      riskFlags.push("极高酒精度");
      riskReasons.push(`酒精度${candidate.abv}%，非常高，谨慎`);
      worthScore = Math.max(0, worthScore - 15);
    } else if (candidate.abv > 10) {
      riskFlags.push("高酒精度");
      riskReasons.push(`酒精度${candidate.abv}%，偏高`);
      worthScore = Math.max(0, worthScore - 10);
    } else if (candidate.abv > 8) {
      riskFlags.push("较高酒精度");
      riskReasons.push(`酒精度${candidate.abv}%，略高`);
      worthScore = Math.max(0, worthScore - 5);
    }

    worthScore = Math.max(0, Math.min(100, worthScore));

    // ══════════════════════════════════════════
    // fitScore — personal match
    // ══════════════════════════════════════════

    fitScore = 50; // default baseline

    // ── Current constraints FIRST (override profile) ──
    // Constraint keywords have higher priority than profile to honor
    // immediate user intent like "今天不苦" over historical IPA love.

    for (const c of constraints) {
      if (c.includes("清爽") || c.includes("crisp")) {
        if (isCrispStyle(styleLower)) {
          fitScore += 15;
          personalReasons.push("符合你要的清爽风格");
        } else if (candidate.abv > 0 && candidate.abv < 5) {
          fitScore += 5;
          personalReasons.push("低酒精度，相对清爽");
        }
      }

      if (c.includes("IPA") || c.toLowerCase().includes("ipa")) {
        if (styleLower.includes("ipa")) {
          fitScore += 15;
          personalReasons.push("符合你要的IPA");
        }
      }

      if (c.includes("不苦") || c.includes("不要太苦")) {
        if (isBitterStyle(styleLower)) {
          fitScore -= 15; // stronger penalty for explicit "不苦"
          riskFlags.push("可能偏苦");
          riskReasons.push("你可能觉得偏苦（虽属偏好风格）");
        }
      }

      if (c.includes("拉格") || c.toLowerCase().includes("lager")) {
        if (styleLower.includes("lager") || styleLower.includes("pils")) {
          fitScore += 12;
          personalReasons.push("符合你要的拉格/皮尔森");
        }
      }

      if (c.includes("尝新") || c.includes("explore")) {
        fitScore += 5;
        personalReasons.push("探索新风格");
      }

      if (c.includes("预算") || c.includes("便宜") || c.includes("省钱") || c.includes("budget")) {
        if (candidate.price != null) {
          fitScore += 5;
          objectiveReasons.push("在预算内");
        }
      }
    }

    // ── Profile matching (lower priority than current constraints) ──
    if (memoryEnabled && profile) {
      // Preferred styles → +10 (reduced from +15 to let constraints dominate)
      for (const ps of profile.preferredStyles) {
        if (styleLower.includes(ps.value.toLowerCase())) {
          // If constraint already matched bitter styles negatively, don't add profile bonus
          if (!constraints.some(c => (c.includes("不苦") || c.includes("不要太苦")) && isBitterStyle(styleLower))) {
            fitScore += 10;
            if (ps.evidenceCount >= 3) {
              personalReasons.push(`你多次喜欢的${ps.value}风格`);
            } else {
              personalReasons.push(`符合你喜欢的${ps.value}`);
            }
          }
          break;
        }
      }

      // Disliked styles → -10
      for (const ds of profile.dislikedStyles) {
        if (styleLower.includes(ds.value.toLowerCase())) {
          fitScore -= 10;
          if (ds.evidenceCount >= 2) {
            riskReasons.push(`你多次反馈不喜欢${ds.value}`);
          } else {
            riskReasons.push(`你曾表示不喜欢${ds.value}`);
          }
          riskFlags.push(`不喜欢风格: ${ds.value}`);
          break;
        }
      }

      // Preferred tag matches → +2 per match
      for (const pt of profile.preferredTags) {
        if (nameAndStyle.includes(pt.value.toLowerCase())) {
          fitScore += 2;
          if (pt.evidenceCount >= 2 && !personalReasons.some((r) => r.includes(pt.value))) {
            personalReasons.push(`你喜欢${pt.value}风味`);
          }
        }
      }

      // Disliked tag matches → -2 per match
      for (const dt of profile.dislikedTags) {
        if (nameAndStyle.includes(dt.value.toLowerCase())) {
          fitScore -= 2;
          if (dt.evidenceCount >= 2 && !riskReasons.some((r) => r.includes(dt.value))) {
            riskReasons.push(`你多次反馈不喜欢${dt.value}`);
          }
        }
      }

      // ABV comfort range — with descriptive reason
      if (profile.abvComfortRange && candidate.abv > 0) {
        if (
          candidate.abv >= profile.abvComfortRange.min &&
          candidate.abv <= profile.abvComfortRange.max
        ) {
          fitScore += 10;
          personalReasons.push(
            `ABV在你舒适区（${profile.abvComfortRange.min}-${profile.abvComfortRange.max}%）`,
          );
        } else if (candidate.abv > profile.abvComfortRange.max) {
          fitScore -= 5;
          riskReasons.push(`酒精度超出你习惯的范围`);
        }
      }
    }

    fitScore = Math.max(0, Math.min(100, fitScore));

    // ══════════════════════════════════════════
    // reason — short Chinese explanation (composite)
    // ══════════════════════════════════════════

    const ratingStr =
      candidate.rating != null && candidate.rating > 0
        ? `评分${candidate.rating.toFixed(1)}` +
          (candidate.ratingsCount != null && candidate.ratingsCount > 0
            ? `(${candidate.ratingsCount}人)`
            : "")
        : null;

    const priceStr = candidate.price != null ? `¥${candidate.price}` : null;

    const infoParts = [ratingStr, priceStr].filter(Boolean).join(" · ");

    const reason =
      personalReasons.length > 0
        ? `${infoParts ? infoParts + " - " : ""}${personalReasons.join("，")}`
        : infoParts || "综合表现适中";

    return {
      ...candidate,
      worthScore,
      fitScore,
      riskFlags,
      reason,
      objectiveReasons: objectiveReasons.length > 0 ? objectiveReasons : undefined,
      personalReasons: personalReasons.length > 0 ? personalReasons : undefined,
      riskReasons: riskReasons.length > 0 ? riskReasons : undefined,
    };
  });
}
