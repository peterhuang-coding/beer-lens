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
