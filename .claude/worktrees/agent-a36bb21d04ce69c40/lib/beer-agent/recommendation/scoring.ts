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
 * Score each candidate with worthScore and fitScore.
 *
 * worthScore (0-100) measures objective quality:
 *   - Distillery/expert rating as primary signal
 *   - Price/value bonuses
 *   - Risk penalties (missing data, high ABV)
 *
 * fitScore (0-100) measures personal preference match:
 *   - Profile style/tag matching
 *   - ABV comfort range
 *   - Constraint keywords (清爽, IPA, 不苦, 拉格)
 */
export function scoreCandidates(
  candidates: ScoredCandidate[],
  profile: ProfileMemory | null,
  constraints: string[],
): ScoredCandidate[] {
  return candidates.map((candidate) => {
    let worthScore: number;
    let fitScore: number;
    const riskFlags: string[] = [];
    const reasonParts: string[] = [];

    const styleLower = (candidate.style || "").toLowerCase();
    const nameAndStyle = `${candidate.displayName} ${candidate.style}`.toLowerCase();

    // ══════════════════════════════════════════
    // worthScore
    // ══════════════════════════════════════════

    if (candidate.rating != null && candidate.rating > 0) {
      worthScore = Math.round(candidate.rating * 20); // 4.0 → 80, 3.5 → 70
    } else {
      worthScore = 50;
      riskFlags.push("无评分数据");
    }

    // Price / volume ratio bonus
    if (candidate.price != null && candidate.volumeMl != null && candidate.volumeMl > 0) {
      const pricePerMl = candidate.price / candidate.volumeMl;
      if (pricePerMl <= 0.015) {
        worthScore = Math.min(100, worthScore + 5);
        reasonParts.push("性价比高");
      }
    }

    // Risk: missing data
    if (!candidate.style && !candidate.brewery) {
      riskFlags.push("信息不足");
      worthScore = Math.max(0, worthScore - 5);
    }

    // Risk: high ABV
    if (candidate.abv > 10) {
      riskFlags.push("高酒精度");
      worthScore = Math.max(0, worthScore - 10);
    } else if (candidate.abv > 8) {
      worthScore = Math.max(0, worthScore - 5);
    }

    worthScore = Math.max(0, Math.min(100, worthScore));

    // ══════════════════════════════════════════
    // fitScore
    // ══════════════════════════════════════════

    fitScore = 50; // default baseline

    if (profile) {
      // Preferred styles → +15
      for (const ps of profile.preferredStyles) {
        if (styleLower.includes(ps.value.toLowerCase())) {
          fitScore += 15;
          reasonParts.push(`偏好${ps.value}`);
          break;
        }
      }

      // Disliked styles → -10
      for (const ds of profile.dislikedStyles) {
        if (styleLower.includes(ds.value.toLowerCase())) {
          fitScore -= 10;
          reasonParts.push(`不推荐${ds.value}`);
          break;
        }
      }

      // Preferred tag matches → +2 per match
      for (const pt of profile.preferredTags) {
        if (nameAndStyle.includes(pt.value.toLowerCase())) {
          fitScore += 2;
        }
      }

      // Disliked tag matches → -2 per match
      for (const dt of profile.dislikedTags) {
        if (nameAndStyle.includes(dt.value.toLowerCase())) {
          fitScore -= 2;
        }
      }

      // ABV comfort range
      if (profile.abvComfortRange && candidate.abv > 0) {
        if (
          candidate.abv >= profile.abvComfortRange.min &&
          candidate.abv <= profile.abvComfortRange.max
        ) {
          fitScore += 10;
          reasonParts.push("ABV适宜");
        } else {
          fitScore -= 5;
        }
      }
    }

    // ── Constraint matching ──

    for (const c of constraints) {
      if (c.includes("清爽")) {
        if (isCrispStyle(styleLower)) {
          fitScore += 10;
          reasonParts.push("清爽风格");
        } else if (candidate.abv > 0 && candidate.abv < 5) {
          fitScore += 5;
          reasonParts.push("低酒精度");
        }
      }

      if (c.includes("IPA") || c.toLowerCase().includes("ipa")) {
        if (styleLower.includes("ipa")) {
          fitScore += 10;
          reasonParts.push("IPA推荐");
        }
      }

      if (c.includes("不苦")) {
        if (isBitterStyle(styleLower)) {
          fitScore -= 10;
          riskFlags.push("可能偏苦");
          reasonParts.push("可能偏苦");
        }
      }

      if (c.includes("拉格") || c.toLowerCase().includes("lager")) {
        if (styleLower.includes("lager") || styleLower.includes("pils")) {
          fitScore += 10;
          reasonParts.push("拉格推荐");
        }
      }
    }

    fitScore = Math.max(0, Math.min(100, fitScore));

    // ══════════════════════════════════════════
    // reason — short Chinese explanation
    // ══════════════════════════════════════════

    const ratingStr =
      candidate.rating != null && candidate.rating > 0
        ? `评分${candidate.rating.toFixed(1)}`
        : null;

    const priceStr = candidate.price != null ? `¥${candidate.price}` : null;

    const infoParts = [ratingStr, priceStr].filter(Boolean).join(" · ");

    const reason =
      reasonParts.length > 0
        ? `${infoParts ? infoParts + " - " : ""}${reasonParts.join("，")}`
        : infoParts || "综合表现适中";

    return {
      ...candidate,
      worthScore,
      fitScore,
      riskFlags,
      reason,
    };
  });
}
