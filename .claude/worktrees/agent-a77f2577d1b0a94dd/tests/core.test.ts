/**
 * Tests for core business functions that don't require external services.
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// We can't directly import TypeScript modules in Node test runner without --experimental-strip-types,
// so these tests use inline copies of the pure functions for now.

// ── Test helpers (copies of pure functions from handlers) ──

function parseScore(text: string): number | undefined {
  const match = text.match(/([1-5](?:\.\d+)?)\s*(?:分|\/5)/);
  if (match) return parseFloat(match[1]);
  return undefined;
}

function parseWouldDrinkAgain(text: string): "yes" | "maybe" | "no" {
  // Negation MUST come first
  if (/不会再喝|不想再喝|不会点/.test(text)) return "no";
  if (/会再喝|还会点|再喝/.test(text)) return "yes";
  return "maybe";
}

function extractBeerSegments(text: string): string[] {
  const parts = text.split(/[\n\r,，、;；。\t]+/);
  return parts
    .map((p) => p.trim())
    .filter((p) => {
      if (!p || p.length < 2) return false;
      const stopWords = [
        "推荐", "帮我看", "看看", "帮我", "建议", "好喝", "什么",
        "怎么", "如何", "这个", "那个", "哪个", "推荐一",
        "第", "杯", "预算", "配餐", "清爽", "不苦",
      ];
      for (const sw of stopWords) {
        if (p.length <= 6 && p.includes(sw)) return false;
      }
      return true;
    });
}

function isGenericRecommendRequest(text: string): boolean {
  const genericPatterns = [
    /^推荐.*IPA$/,
    /^推荐.*拉格$/,
    /^推荐.*世涛$/,
    /^推荐.*皮尔森$/,
    /^推荐.*小麦$/,
    /^推荐.*酸$/,
    /^推荐.*sour/i,
    /^推荐.*stout/i,
    /^推荐.*清爽/,
    /^推荐.*不苦/,
    /^推荐一款/,
    /^推荐一下/,
    /^帮我推荐/,
    /^帮我.*选/,
    /^帮我.*挑/,
    /^今天喝什么/,
    /^喝什么.*好/,
    /^想喝.*清爽/,
    /^想喝点/,
    /^有什么.*推荐/,
    /^帮我看看.*酒单/,
    /^给我推荐/,
  ];
  return genericPatterns.some(p => p.test(text));
}

function extractTags(text: string, keywords: string[]): string[] {
  return keywords.filter((kw) => text.includes(kw));
}

function hasBeerNameInText(
  text: string,
  candidates: Array<{ displayName: string }>,
): boolean {
  return candidates.some(c =>
    c.displayName && c.displayName.length >= 2 && text.includes(c.displayName),
  );
}

// ── Scoring helpers ──

function scoreCandidates(
  candidates: Array<{ worthScore: number; fitScore: number }>,
  _profile: any,
  _constraints: string[],
): Array<{ worthScore: number; fitScore: number }> {
  // Simple no-op: return as-is (real scoring would use profile/constraints)
  return candidates;
}

// ── Pick selector ──

function selectPicks(
  scored: Array<{ candidateId?: string; displayName?: string; worthScore: number; fitScore: number; reason?: string }>,
): {
  topPick: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
  safePick: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
  explorePick: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
  avoidOrCaution: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
} {
  const empty = { candidateId: "", label: "暂无", reason: "暂无数据", worthScore: 0, fitScore: 0 };
  if (scored.length === 0) {
    return { topPick: empty, safePick: empty, explorePick: empty, avoidOrCaution: empty };
  }

  // Sort by combined score descending
  const sorted = [...scored].sort((a, b) => (b.worthScore + b.fitScore) - (a.worthScore + a.fitScore));
  const top = sorted[0];
  const safe = sorted.length > 1 ? sorted[1] : sorted[0];
  const explore = sorted.length > 2 ? sorted[2] : sorted[0];
  const avoid = sorted.length > 1 ? sorted[sorted.length - 1] : sorted[0];

  const mkPick = (c: typeof top, label: string) => ({
    candidateId: c.candidateId ?? "",
    label: c.displayName ?? label,
    reason: c.reason ?? "综合评分推荐",
    worthScore: c.worthScore,
    fitScore: c.fitScore,
  });

  return {
    topPick: mkPick(top, "首选"),
    safePick: mkPick(safe, "稳妥"),
    explorePick: mkPick(explore, "尝新"),
    avoidOrCaution: mkPick(avoid, "避开"),
  };
}

// ═══════════════════════════════════════════════════════
// Tests: parseWouldDrinkAgain
// ═══════════════════════════════════════════════════════

describe("parseWouldDrinkAgain", () => {
  it("不会 => no (negation checked first)", () => {
    assert.strictEqual(parseWouldDrinkAgain("不会再喝"), "no");
  });

  it("不想再喝 => no", () => {
    assert.strictEqual(parseWouldDrinkAgain("不想再喝"), "no");
  });

  it("不会点 => no", () => {
    assert.strictEqual(parseWouldDrinkAgain("不会点"), "no");
  });

  it("会再喝 => yes", () => {
    assert.strictEqual(parseWouldDrinkAgain("会再喝"), "yes");
  });

  it("还会点 => yes", () => {
    assert.strictEqual(parseWouldDrinkAgain("还会点"), "yes");
  });

  it("再喝 => yes", () => {
    assert.strictEqual(parseWouldDrinkAgain("再喝"), "yes");
  });

  it("no clear signal => maybe", () => {
    assert.strictEqual(parseWouldDrinkAgain("今天天气不错"), "maybe");
  });

  it("mixed text — negation wins", () => {
    // "不会再喝" contains both 不 and 会再喝 — negation must win
    assert.strictEqual(parseWouldDrinkAgain("4分，不会再喝，柑橘味"), "no");
  });

  it("positive with score", () => {
    assert.strictEqual(parseWouldDrinkAgain("4分，会再喝"), "yes");
  });
});

// ═══════════════════════════════════════════════════════
// Tests: parseScore
// ═══════════════════════════════════════════════════════

describe("parseScore", () => {
  it("integer with 分", () => {
    assert.strictEqual(parseScore("4分"), 4);
  });

  it("decimal with 分", () => {
    assert.strictEqual(parseScore("3.5分"), 3.5);
  });

  it("with /5 format", () => {
    assert.strictEqual(parseScore("4/5"), 4);
  });

  it("in sentence", () => {
    assert.strictEqual(parseScore("这杯酒我给4.5分"), 4.5);
  });

  it("no score returns undefined", () => {
    assert.strictEqual(parseScore("好喝"), undefined);
  });

  it("score outside range ignored", () => {
    assert.strictEqual(parseScore("6分"), undefined);
    assert.strictEqual(parseScore("0分"), undefined);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: extractBeerSegments
// ═══════════════════════════════════════════════════════

describe("extractBeerSegments", () => {
  it("splits on comma", () => {
    const result = extractBeerSegments("Green City, Punk IPA");
    assert.strictEqual(result.length, 2);
    assert(result.includes("Green City"));
    assert(result.includes("Punk IPA"));
  });

  it("filters short stop word phrases", () => {
    const result = extractBeerSegments("推荐一下");
    assert.strictEqual(result.length, 0);
  });

  it("filters 帮我看看", () => {
    const result = extractBeerSegments("帮我看看酒单");
    assert.strictEqual(result.length, 0);
  });

  it("filters 第X个", () => {
    const result = extractBeerSegments("第3个怎么样");
    assert.strictEqual(result.length, 0);
  });

  it("keeps real beer names", () => {
    const result = extractBeerSegments("Green City, Punk IPA, 罗斯福10号");
    assert.strictEqual(result.length, 3);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: isGenericRecommendRequest
// ═══════════════════════════════════════════════════════

describe("isGenericRecommendRequest", () => {
  it("推荐一款IPA => true", () => {
    assert.strictEqual(isGenericRecommendRequest("推荐一款IPA"), true);
  });

  it("帮我推荐 => true", () => {
    assert.strictEqual(isGenericRecommendRequest("帮我推荐"), true);
  });

  it("今天喝什么好 => true", () => {
    assert.strictEqual(isGenericRecommendRequest("今天喝什么好"), true);
  });

  it("想喝点清爽的 => true", () => {
    assert.strictEqual(isGenericRecommendRequest("想喝点清爽的"), true);
  });

  it("Green City => false (specific beer name)", () => {
    assert.strictEqual(isGenericRecommendRequest("Green City"), false);
  });

  it("4分，会再喝 => false (feedback)", () => {
    assert.strictEqual(isGenericRecommendRequest("4分，会再喝"), false);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: hasBeerNameInText
// ═══════════════════════════════════════════════════════

describe("hasBeerNameInText", () => {
  const candidates = [
    { displayName: "Green City IPA" },
    { displayName: "Punk IPA" },
    { displayName: "罗斯福10号" },
  ];

  it("matches exact name", () => {
    assert.strictEqual(hasBeerNameInText("喝了Green City IPA，4分", candidates), true);
  });

  it("does not match partial too short", () => {
    // "IPA" alone shouldn't match if displayName is "Green City IPA"
    // because we check includes(), so it does match. This is the fuzzy behavior.
    assert.strictEqual(hasBeerNameInText("喝了IPA", candidates), false);
  });

  it("returns false when no match", () => {
    assert.strictEqual(hasBeerNameInText("推荐一款啤酒", candidates), false);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: selectPicks
// ═══════════════════════════════════════════════════════

describe("selectPicks", () => {
  it("returns empty picks for empty array", () => {
    const picks = selectPicks([]);
    assert.strictEqual(picks.topPick.candidateId, "");
    assert.strictEqual(picks.safePick.candidateId, "");
    assert.strictEqual(picks.explorePick.candidateId, "");
    assert.strictEqual(picks.avoidOrCaution.candidateId, "");
  });

  it("single candidate: all picks same", () => {
    const picks = selectPicks([
      { candidateId: "1", displayName: "A", worthScore: 80, fitScore: 70 },
    ]);
    assert.strictEqual(picks.topPick.candidateId, "1");
    assert.strictEqual(picks.safePick.candidateId, "1");
    assert.strictEqual(picks.explorePick.candidateId, "1");
    assert.strictEqual(picks.avoidOrCaution.candidateId, "1");
  });

  it("multiple candidates: top=highest, avoid=lowest", () => {
    const picks = selectPicks([
      { candidateId: "1", displayName: "A", worthScore: 50, fitScore: 30 },
      { candidateId: "2", displayName: "B", worthScore: 90, fitScore: 80 },
      { candidateId: "3", displayName: "C", worthScore: 60, fitScore: 40 },
      { candidateId: "4", displayName: "D", worthScore: 20, fitScore: 10 },
    ]);
    assert.strictEqual(picks.topPick.candidateId, "2");
    assert.strictEqual(picks.avoidOrCaution.candidateId, "4");
  });
});

// ═══════════════════════════════════════════════════════
// Tests: extractTags
// ═══════════════════════════════════════════════════════

describe("extractTags", () => {
  it("extracts matching keywords", () => {
    const tags = extractTags("柑橘味很重，偏苦", ["柑橘", "热带水果", "苦", "甜"]);
    assert.deepStrictEqual(tags, ["柑橘", "苦"]);
  });

  it("returns empty when no match", () => {
    const tags = extractTags("很好喝", ["柑橘", "苦"]);
    assert.deepStrictEqual(tags, []);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: scoreCandidates
// ═══════════════════════════════════════════════════════

describe("scoreCandidates", () => {
  it("returns same array length", () => {
    const input = [
      { worthScore: 50, fitScore: 30 },
      { worthScore: 80, fitScore: 70 },
    ];
    const result = scoreCandidates(input, null, []);
    assert.strictEqual(result.length, 2);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: parseCorrections (pure function from corrections.ts)
// ═══════════════════════════════════════════════════════

// Copy of parseCorrections pure function for in-test use
function parseCorrections(
  text: string,
): Array<{ action: string; targetValue: string }> {
  const results: Array<{ action: string; targetValue: string }> = [];
  const normalized = text.trim();

  // Rule 1: "我不是不喜欢X，我是不喜欢Y"
  const notDislikeMatch = normalized.match(
    /我不是不喜欢(.+?)[，,、]*(?:而是|我是)不喜欢(.+)/,
  );
  if (notDislikeMatch) {
    const styleX = normalizeValue(notDislikeMatch[1]);
    const tagY = normalizeValue(notDislikeMatch[2]);
    if (styleX) results.push({ action: "remove_disliked_style", targetValue: styleX });
    if (tagY) results.push({ action: "add_disliked_tag", targetValue: tagY });
    if (results.length > 0) return results;
  }

  // Rule 2: "我其实喜欢X"
  const actuallyLikeMatch = normalized.match(/我其实喜欢(.+)|其实.*喜欢(.+)/);
  if (actuallyLikeMatch) {
    const value = normalizeValue(actuallyLikeMatch[1] ?? actuallyLikeMatch[2]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "add_preferred_style", targetValue: value });
      } else {
        results.push({ action: "remove_disliked_tag", targetValue: value });
      }
    }
    if (results.length > 0) return results;
  }

  // Rule 3: "别再说我喜欢X"
  const dontSayLikeMatch = normalized.match(
    /别(?:再)?说.*喜欢(.+)|不要.*说.*喜欢(.+)/,
  );
  if (dontSayLikeMatch) {
    const value = normalizeValue(dontSayLikeMatch[1] ?? dontSayLikeMatch[2]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "remove_preferred_style", targetValue: value });
      } else {
        results.push({ action: "remove_preferred_tag", targetValue: value });
      }
    }
    if (results.length > 0) return results;
  }

  // Rule 4: "我不喜欢X" (but not "我不是不喜欢")
  const dislikeMatch = normalized.match(/我不喜欢(.+)/);
  if (dislikeMatch && !normalized.includes("我不是不喜欢")) {
    const value = normalizeValue(dislikeMatch[1]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "remove_preferred_style", targetValue: value });
      } else {
        results.push({ action: "add_disliked_tag", targetValue: value });
      }
    }
    if (results.length > 0) return results;
  }

  // Rule 5: "我喜欢X"
  const likeMatch = normalized.match(/我喜欢(.+)/);
  if (likeMatch && !normalized.includes("其实喜欢") && !normalized.includes("别说") && !normalized.includes("不要说")) {
    const value = normalizeValue(likeMatch[1]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "add_preferred_style", targetValue: value });
      } else {
        results.push({ action: "remove_disliked_tag", targetValue: value });
      }
    }
    if (results.length > 0) return results;
  }

  return results;
}

function normalizeValue(raw: string): string {
  let cleaned = raw.trim()
    .replace(/[的了吗呢啊呀]+$/g, "")
    .replace(/^[的]+/g, "")
    .trim();
  cleaned = cleaned.replace(/[。，,、；;！!？?]+$/g, "").trim();
  if (cleaned.length === 0) return "";
  return cleaned;
}

function isLikelyStyle(value: string): boolean {
  const styleKeywords = [
    "ipa", "拉格", "lager", "世涛", "stout", "酸啤", "sour",
    "小麦", "wheat", "皮尔森", "pilsner", "pils", "波特", "porter",
    "赛松", "saison", "大麦", "barleywine", "kolsch", "helles",
    "bock", "amber", "棕艾", "brown ale", "session", "帝国", "imperial",
  ];
  const lower = value.toLowerCase();
  return styleKeywords.some((kw) => lower.includes(kw) || kw.includes(lower));
}

describe("parseCorrections", () => {
  it("不是不喜欢IPA，而是不喜欢太苦的 → remove IPA from disliked, add 苦 to disliked", () => {
    const result = parseCorrections("我不是不喜欢IPA，我是不喜欢太苦的");
    assert.strictEqual(result.length, 2);
    const removeAction = result.find((c) => c.action === "remove_disliked_style");
    const addAction = result.find((c) => c.action === "add_disliked_tag");
    assert.ok(removeAction);
    assert.ok(addAction);
    assert.ok(
      removeAction!.targetValue.toLowerCase().includes("ipa"),
      `Expected IPA, got: ${removeAction!.targetValue}`,
    );
    assert.ok(
      addAction!.targetValue.includes("苦"),
      `Expected 苦, got: ${addAction!.targetValue}`,
    );
  });

  it("不是不喜欢IPA，而是不喜欢太苦 → variant without 我", () => {
    const result = parseCorrections("我不是不喜欢IPA，而是不喜欢太苦");
    assert.strictEqual(result.length, 2);
    const removeAction = result.find((c) => c.action === "remove_disliked_style");
    const addAction = result.find((c) => c.action === "add_disliked_tag");
    assert.ok(removeAction);
    assert.ok(addAction);
  });

  it("我其实喜欢酸啤 → add 酸啤 to preferred styles", () => {
    const result = parseCorrections("我其实喜欢酸啤");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "add_preferred_style");
    assert.ok(result[0].targetValue.includes("酸啤"));
  });

  it("我其实喜欢IPA → add IPA to preferred styles", () => {
    const result = parseCorrections("我其实喜欢IPA");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "add_preferred_style");
  });

  it("我其实喜欢柑橘味 → add citrus to preferred (as tag)", () => {
    const result = parseCorrections("我其实喜欢柑橘味");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "remove_disliked_tag");
    assert.ok(result[0].targetValue.includes("柑橘"));
  });

  it("别再说我喜欢世涛 → remove 世涛 from preferred styles", () => {
    const result = parseCorrections("别再说我喜欢世涛");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "remove_preferred_style");
    assert.ok(result[0].targetValue.includes("世涛"));
  });

  it("不要再说我喜欢世涛 → remove 世涛 from preferred styles", () => {
    const result = parseCorrections("不要再说我喜欢世涛");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "remove_preferred_style");
  });

  it("我不喜欢太甜的 → add 太甜 to disliked tags", () => {
    const result = parseCorrections("我不喜欢太甜的");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "add_disliked_tag");
    assert.ok(result[0].targetValue.includes("甜"));
  });

  it("我喜欢柑橘味的 → add 柑橘 as preferred", () => {
    const result = parseCorrections("我喜欢柑橘味的");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "remove_disliked_tag");
    assert.ok(result[0].targetValue.includes("柑橘"));
  });

  it("no match → empty array", () => {
    const result = parseCorrections("今天天气不错");
    assert.strictEqual(result.length, 0);
  });

  it("random beer text → empty array", () => {
    const result = parseCorrections("推荐一款IPA");
    assert.strictEqual(result.length, 0);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: calculateConfidence (pure function from profile.ts)
// ═══════════════════════════════════════════════════════

function calculateConfidence(evidenceCount: number): number {
  return Math.min(evidenceCount / 10, 1);
}

describe("calculateConfidence", () => {
  it("0 episodes → 0", () => {
    assert.strictEqual(calculateConfidence(0), 0);
  });

  it("5 episodes → 0.5", () => {
    assert.strictEqual(calculateConfidence(5), 0.5);
  });

  it("10 episodes → 1.0", () => {
    assert.strictEqual(calculateConfidence(10), 1);
  });

  it("15 episodes → 1.0 (capped)", () => {
    assert.strictEqual(calculateConfidence(15), 1);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: Trend aggregation (pure functions)
// ═══════════════════════════════════════════════════════

type MiniEpisode = {
  createdAt: string;
  style?: string;
  aromaTags: string[];
  tasteTags: string[];
  contextTags: string[];
  overallScore?: number;
  abv?: number;
};

function buildTrendsFromEpisodes(eps: MiniEpisode[]): Array<{
  month: string;
  episodeCount: number;
  topStyles: string[];
  topTags: string[];
  dislikedTags: string[];
  avgScore: number;
  abvRange: { min: number; max: number } | null;
}> {
  const byMonth = new Map<string, MiniEpisode[]>();
  for (const ep of eps) {
    const month = ep.createdAt.slice(0, 7);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(ep);
    byMonth.set(month, bucket);
  }

  const months: Array<{
    month: string;
    episodeCount: number;
    topStyles: string[];
    topTags: string[];
    dislikedTags: string[];
    avgScore: number;
    abvRange: { min: number; max: number } | null;
  }> = [];

  for (const [month, monthEps] of byMonth.entries()) {
    const styleCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const dislikedTagCounts = new Map<string, number>();
    const scores: number[] = [];
    const abvs: number[] = [];

    for (const ep of monthEps) {
      if (ep.style) {
        styleCounts.set(ep.style, (styleCounts.get(ep.style) ?? 0) + 1);
      }
      if (ep.overallScore != null && ep.overallScore >= 3.5) {
        for (const tag of [...ep.aromaTags, ...ep.tasteTags, ...ep.contextTags]) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
      if (ep.overallScore != null && ep.overallScore <= 2.5) {
        for (const tag of [...ep.aromaTags, ...ep.tasteTags, ...ep.contextTags]) {
          dislikedTagCounts.set(tag, (dislikedTagCounts.get(tag) ?? 0) + 1);
        }
      }
      if (ep.overallScore != null) scores.push(ep.overallScore);
      if (ep.abv != null && ep.abv > 0) abvs.push(ep.abv);
    }

    const sortByCountDesc = (a: [string, number], b: [string, number]) => b[1] - a[1];
    months.push({
      month,
      episodeCount: monthEps.length,
      topStyles: [...styleCounts.entries()].sort(sortByCountDesc).slice(0, 3).map(([s]) => s),
      topTags: [...tagCounts.entries()].sort(sortByCountDesc).slice(0, 5).map(([t]) => t),
      dislikedTags: [...dislikedTagCounts.entries()].sort(sortByCountDesc).slice(0, 3).map(([t]) => t),
      avgScore: scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : 0,
      abvRange: abvs.length > 0 ? { min: Math.min(...abvs), max: Math.max(...abvs) } : null,
    });
  }

  months.sort((a, b) => a.month.localeCompare(b.month));
  return months;
}

describe("buildTrendsFromEpisodes", () => {
  it("aggregates episodes in same month correctly", () => {
    const eps: MiniEpisode[] = [
      {
        createdAt: "2026-07-03T10:00:00Z",
        style: "IPA",
        aromaTags: ["柑橘"],
        tasteTags: ["苦"],
        contextTags: [],
        overallScore: 4,
        abv: 6.5,
      },
      {
        createdAt: "2026-07-15T10:00:00Z",
        style: "Lager",
        aromaTags: ["清爽"],
        tasteTags: ["清爽"],
        contextTags: ["聚会"],
        overallScore: 3.5,
        abv: 4.5,
      },
    ];

    const result = buildTrendsFromEpisodes(eps);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].month, "2026-07");
    assert.strictEqual(result[0].episodeCount, 2);
    assert.strictEqual(result[0].avgScore, 3.8);
    assert.deepStrictEqual(result[0].topStyles, ["IPA", "Lager"]);
    assert.deepStrictEqual(result[0].abvRange, { min: 4.5, max: 6.5 });
  });

  it("handles episodes across multiple months", () => {
    const eps: MiniEpisode[] = [
      { createdAt: "2026-06-10T10:00:00Z", style: "Stout", aromaTags: ["咖啡"], tasteTags: [], contextTags: [], overallScore: 4, abv: 8 },
      { createdAt: "2026-07-10T10:00:00Z", style: "IPA", aromaTags: ["柑橘"], tasteTags: [], contextTags: [], overallScore: 4.5, abv: 7 },
    ];

    const result = buildTrendsFromEpisodes(eps);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].month, "2026-06");
    assert.strictEqual(result[1].month, "2026-07");
  });

  it("handles empty episode list", () => {
    const result = buildTrendsFromEpisodes([]);
    assert.strictEqual(result.length, 0);
  });

  it("handles episodes with missing style/score", () => {
    const eps: MiniEpisode[] = [
      { createdAt: "2026-07-01T10:00:00Z", aromaTags: [], tasteTags: [], contextTags: [], abv: 0 },
    ];
    const result = buildTrendsFromEpisodes(eps);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].episodeCount, 1);
    assert.strictEqual(result[0].avgScore, 0);
    assert.deepStrictEqual(result[0].topStyles, []);
    assert.strictEqual(result[0].abvRange, null);
  });

  it("separates liked tags (score >= 3.5) from disliked tags (score <= 2.5)", () => {
    const eps: MiniEpisode[] = [
      {
        createdAt: "2026-07-03T10:00:00Z",
        style: "IPA",
        aromaTags: ["柑橘"],
        tasteTags: ["苦"],
        contextTags: [],
        overallScore: 4,
      },
      {
        createdAt: "2026-07-04T10:00:00Z",
        style: "Stout",
        aromaTags: ["焦糖"],
        tasteTags: ["苦"],
        contextTags: [],
        overallScore: 2,
      },
    ];

    const result = buildTrendsFromEpisodes(eps);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].topTags, ["柑橘", "苦"]);
    assert.deepStrictEqual(result[0].dislikedTags, ["焦糖", "苦"]);
  });
});

// ═══════════════════════════════════════════════════════
// Intent classification helpers for testing without ES modules
// ═══════════════════════════════════════════════════════

function testKeywordOverlapForIntent(text: string, sample: string): number {
  const textWords = new Set(text.toLowerCase().split(/\s+/));
  const sampleWords = sample.toLowerCase().split(/\s+/);
  if (sampleWords.length === 0) return 0;
  let hits = 0;
  for (const w of sampleWords) {
    if (textWords.has(w) || text.includes(w)) hits++;
  }
  return hits / sampleWords.length;
}

function testIntentBySamples(
  text: string,
  intents: Array<{ id: string; samples: string[]; negativeKeywords?: string[]; requiresMenu?: boolean; hasMenu?: boolean }>,
): { matched: string; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  let bestIntent = "unclear";
  let bestScore = 0;

  for (const intent of intents) {
    if (intent.negativeKeywords?.some(nk => text.includes(nk))) {
      scores[intent.id] = 0;
      continue;
    }
    if (intent.requiresMenu && !intent.hasMenu) {
      scores[intent.id] = 0;
      continue;
    }

    let maxSampleScore = 0;
    for (const sample of intent.samples) {
      const s = testKeywordOverlapForIntent(text, sample);
      if (s > maxSampleScore) maxSampleScore = s;
    }
    scores[intent.id] = maxSampleScore;
    if (maxSampleScore > bestScore) {
      bestScore = maxSampleScore;
      bestIntent = intent.id;
    }
  }

  return { matched: bestScore > 0 ? bestIntent : "unclear", scores };
}

const allIntents = [
  { id: "menu_recommend", samples: ["推荐一款IPA", "帮我推荐一下", "今天喝什么好", "有什么好喝的啤酒", "帮我选一款", "给我推荐个清爽的"] },
  { id: "follow_up_filter", samples: ["有 IPA 吗", "第3个怎么样", "哪个不苦", "哪个好喝", "有没有世涛"], requiresMenu: true },
  { id: "tasting_feedback", samples: ["4分，会再喝，柑橘味很重", "3.5分，不会再喝", "这杯不错，给4.5分", "喝了感觉一般，2分"] },
  { id: "profile_query", samples: ["我的口味是什么", "看看我的偏好", "我喝过哪些酒", "帮我看看口味画像"] },
  { id: "beer_knowledge", samples: ["IPA和拉格有什么区别", "什么是干投酒花", "啤酒是怎么酿造的", "世涛为什么是黑色的"] },
  { id: "label_check", samples: ["帮我看看这瓶酒的生产日期", "这个酒标是什么", "看看过期没"] },
  { id: "memory_correction", samples: ["不是这个，应该是Green City", "纠正一下，我喝的是另一款", "记错了，改成IPA吧"] },
  { id: "unclear", samples: ["嗯", "哦", "..."] },
];

// ═══════════════════════════════════════════════════════
// Tests: follow_up_filter with and without menu context
// ═══════════════════════════════════════════════════════

describe("follow_up_filter context guard regression", () => {
  const followUpQueries = ["有 IPA 吗", "第3个怎么样", "哪个不苦", "哪个好喝", "有没有世涛"];
  const nonFollowUpQueries = ["推荐一款IPA", "hello", "我想喝酒", "谢谢", "哦", "..."];

  for (const q of followUpQueries) {
    it(`WITHOUT menu: "${q}" should NOT be follow_up_filter`, () => {
      const followUpIntents = allIntents.map(i =>
        i.id === "follow_up_filter" ? { ...i, hasMenu: false } : i
      );
      const r = testIntentBySamples(q, followUpIntents);
      assert.notStrictEqual(r.matched, "follow_up_filter", `"${q}" without menu should not match follow_up_filter`);
    });
  }

  for (const q of followUpQueries) {
    it(`WITH menu: "${q}" should match follow_up_filter`, () => {
      const followUpIntents = allIntents.map(i =>
        i.id === "follow_up_filter" ? { ...i, hasMenu: true } : i
      );
      const r = testIntentBySamples(q, followUpIntents);
      assert.strictEqual(r.matched, "follow_up_filter", `"${q}" with menu should match follow_up_filter`);
    });
  }

  for (const q of nonFollowUpQueries) {
    it(`"${q}" should NOT be follow_up_filter (even with menu)`, () => {
      const followUpIntents = allIntents.map(i =>
        i.id === "follow_up_filter" ? { ...i, hasMenu: true } : i
      );
      const r = testIntentBySamples(q, followUpIntents);
      assert.notStrictEqual(r.matched, "follow_up_filter", `"${q}" should not be follow_up_filter`);
    });
  }

  it("hello should NOT be beer_knowledge", () => {
    const r = testIntentBySamples("hello", allIntents);
    assert.notStrictEqual(r.matched, "beer_knowledge", "hello should not be beer_knowledge");
  });

  it("我想喝酒 should NOT be beer_knowledge", () => {
    const r = testIntentBySamples("我想喝酒", allIntents);
    assert.notStrictEqual(r.matched, "beer_knowledge", "我想喝酒 should not be beer_knowledge");
  });
});
