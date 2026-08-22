/**
 * Tests for the recommendation pick selector + reply builder.
 *
 * Covers the 2026-08-23 fix: when the whole menu has no rating data
 * (all scores tied at 0), the four picks must be four DIFFERENT beers
 * instead of all collapsing onto the first candidate, "我会先跳过" must
 * not contradict the picks, and the caution list must be deduped/capped.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/pick-selector.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { selectPicks } from "../lib/beer-agent/recommendation/pick-selector.ts";
import { buildRecommendationReply } from "../lib/beer-agent/recommendation/reply-builder.ts";
import type { ScoredCandidate } from "../lib/beer-agent/recommendation/types.ts";

function candidate(overrides: Partial<ScoredCandidate> & { candidateId: string }): ScoredCandidate {
  return {
    menuIndex: 0,
    displayName: overrides.candidateId,
    brewery: "",
    style: "",
    abv: 0,
    price: null,
    volumeMl: null,
    worthScore: 0,
    fitScore: 0,
    riskFlags: [],
    reason: "",
    ...overrides,
  };
}

// ── no-data menu (all scores 0, all risk-flagged) ──

function noDataMenu(): ScoredCandidate[] {
  return [
    candidate({ candidateId: "c1", displayName: "柚子大米拉格", style: "拉格", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c2", displayName: "德式黑啤", style: "德式黑啤", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c3", displayName: "西海岸IPA", style: "西海岸IPA", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c4", displayName: "浑浊IPA", style: "双倍干投浑浊IPA", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c5", displayName: "水果酸艾尔", style: "水果酸艾尔", riskFlags: ["无评分数据"] }),
  ];
}

test("no-data menu: four picks are four different beers", () => {
  // Two safe styles on the menu so safePick can differ from topPick.
  const menu = [
    candidate({ candidateId: "c1", displayName: "柚子大米拉格", style: "拉格", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c6", displayName: "新西兰拉格", style: "新西兰拉格", riskFlags: ["无评分数据"] }),
    ...noDataMenu().slice(1),
  ];
  const picks = selectPicks(menu);
  const ids = [
    picks.topPick.candidateId,
    picks.safePick.candidateId,
    picks.explorePick.candidateId,
    picks.avoidOrCaution.candidateId,
  ];
  assert.equal(new Set(ids).size, 4, `picks must be distinct, got: ${ids.join(", ")}`);
});

test("no-data menu: safePick prefers a safe style (Chinese keywords)", () => {
  // 拉格 is in the safe keyword list; with a second safe style present,
  // safePick must pick the other lager instead of repeating topPick.
  const menu = [
    candidate({ candidateId: "c1", displayName: "柚子大米拉格", style: "拉格", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c6", displayName: "新西兰拉格", style: "新西兰拉格", riskFlags: ["无评分数据"] }),
    candidate({ candidateId: "c3", displayName: "西海岸IPA", style: "西海岸IPA", riskFlags: ["无评分数据"] }),
  ];
  const picks = selectPicks(menu);
  assert.equal(picks.safePick.candidateId, "c6");
});

test("no-data menu: avoidOrCaution is not the same beer as top/safe/explore", () => {
  const picks = selectPicks(noDataMenu());
  assert.notEqual(picks.avoidOrCaution.candidateId, picks.topPick.candidateId);
  assert.notEqual(picks.avoidOrCaution.candidateId, picks.safePick.candidateId);
  assert.notEqual(picks.avoidOrCaution.candidateId, picks.explorePick.candidateId);
});

test("single candidate: picks fall back to it, avoidOrCaution stays empty", () => {
  const picks = selectPicks([candidate({ candidateId: "solo", displayName: "独苗" })]);
  assert.equal(picks.topPick.candidateId, "solo");
  assert.equal(picks.safePick.candidateId, "solo");
  assert.equal(picks.explorePick.candidateId, "solo");
  assert.equal(picks.avoidOrCaution.candidateId, "");
});

test("empty candidates: all picks empty", () => {
  const picks = selectPicks([]);
  assert.equal(picks.topPick.candidateId, "");
  assert.equal(picks.avoidOrCaution.candidateId, "");
});

// ── normal data: scoring differentiates ──

test("scored menu: top/safe/explore are distinct by rule", () => {
  const menu = [
    candidate({ candidateId: "lag", displayName: "清爽拉格", style: "拉格", worthScore: 50, fitScore: 90 }),
    candidate({ candidateId: "ipa", displayName: "三倍IPA", style: "三倍浑浊IPA", worthScore: 95, fitScore: 30, riskFlags: ["高酒精"] }),
    candidate({ candidateId: "stout", displayName: "帝国世涛", style: "帝国世涛", worthScore: 80, fitScore: 40 }),
  ];
  const picks = selectPicks(menu);
  assert.equal(picks.topPick.candidateId, "lag", "highest combined (140) wins");
  assert.equal(picks.safePick.candidateId, "lag");
  assert.notEqual(picks.explorePick.candidateId, "lag");
  assert.equal(picks.explorePick.candidateId, "ipa", "highest worthScore among risky wins");
  assert.equal(picks.avoidOrCaution.candidateId, "stout", "lowest fitScore among remaining wins");
});

// ── reply builder ──

test("reply: all-data-missing menu gets honesty note + no skip line", () => {
  const picks = selectPicks(noDataMenu());
  const reply = buildRecommendationReply(picks, noDataMenu());
  assert.ok(reply.includes("这批酒都没有评分数据"), "honesty note present");
  assert.ok(!reply.includes("我会先跳过"), "no skip line when avoid has no basis");
});

test("reply: caution list dedupes and caps at 8 names", () => {
  const menu = Array.from({ length: 12 }, (_, i) =>
    candidate({ candidateId: `b${i}`, displayName: i < 2 ? "同名啤酒" : `啤酒${i}`, riskFlags: ["无评分数据"] }),
  );
  const picks = selectPicks(menu);
  const reply = buildRecommendationReply(picks, menu);
  // 12 candidates, 2 share one name → 11 unique names, capped at 8 shown
  assert.ok(reply.includes("等11款"), "total unique count shown when capped");
  const cautionLine = reply.split("\n").find((l) => l.startsWith("⚠️")) ?? "";
  assert.equal(cautionLine.split("同名啤酒").length - 1, 1, "duplicate name deduped to one occurrence in the caution line");
});

test("reply: skip line present when avoidOrCaution has a candidate", () => {
  const menu = noDataMenu().map((c) => ({
    ...c,
    riskFlags: [],
  }));
  const picks = selectPicks(menu);
  const reply = buildRecommendationReply(picks, menu);
  assert.ok(reply.includes("我会先跳过"), "skip line present when data exists");
});
