/**
 * tests/llm-rules.test.mts
 *
 * Unit tests for the keyword rule fast-path. Verifies that common
 * Chinese beer intents land on the right skill without ever calling the
 * LLM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordRoute } from "../lib/harness/router-rules.ts";
import { registerSkill, unregisterSkill, listSkills } from "../lib/harness/router.ts";
import type { AgentReply } from "../lib/harness/types.ts";

const STUB_REPLY: AgentReply = {
  skillId: "stub",
  reply: "ok",
  candidates: [],
  picks: {
    topPick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
    safePick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
    explorePick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
    avoidOrCaution: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
  },
  profileSummary: "",
  errors: [],
};

function reset(): void {
  for (const s of listSkills()) unregisterSkill(s.id);
}

function stub(id: string, enabled = true): void {
  registerSkill({
    id: id as never,
    label: id,
    description: `${id} stub`,
    enabled,
    preferredHandler: "active",
    handlerFile: `stub/${id}.ts`,
    invoke: async () => STUB_REPLY,
  });
}

test("keywordRoute: matches menu_recommend for 推荐 + IPA", () => {
  reset();
  stub("menu_recommend");
  const d = keywordRoute("推荐一款 NEIPA");
  assert.ok(d);
  assert.equal(d!.skill_id, "menu_recommend");
  assert.equal((d!.params as { style: string }).style, "NEIPA");
});

test("keywordRoute: extracts ABV numbers as max/min bounds", () => {
  reset();
  stub("menu_recommend");
  const d = keywordRoute("想要 IPA,ABV 6.5");
  assert.ok(d);
  const params = d!.params as { max_abv: number; min_abv: number };
  assert.equal(params.max_abv, 7);
  assert.equal(params.min_abv, 6);
});

test("keywordRoute: routes '什么是 NEIPA' to beer_knowledge", () => {
  reset();
  stub("beer_knowledge");
  const d = keywordRoute("什么是 NEIPA?");
  assert.ok(d);
  assert.equal(d!.skill_id, "beer_knowledge");
  assert.equal((d!.params as { question: string }).question, "什么是 NEIPA?");
});

test("keywordRoute: routes '第3个' to follow_up_filter", () => {
  reset();
  stub("follow_up_filter");
  const d = keywordRoute("第3个");
  assert.ok(d);
  assert.equal(d!.skill_id, "follow_up_filter");
  assert.equal((d!.params as { index: number }).index, 3);
});

test("keywordRoute: routes '我其实不喜欢 IPA' to memory_correction", () => {
  reset();
  stub("memory_correction");
  const d = keywordRoute("我其实不喜欢 IPA");
  assert.ok(d);
  assert.equal(d!.skill_id, "memory_correction");
});

test("keywordRoute: routes '喝过一款好喝的' to tasting_feedback (positive)", () => {
  reset();
  stub("tasting_feedback");
  const d = keywordRoute("喝过一款好喝的");
  assert.ok(d);
  assert.equal(d!.skill_id, "tasting_feedback");
  assert.equal((d!.params as { sentiment: string }).sentiment, "positive");
});

test("keywordRoute: returns null when no rule fires", () => {
  reset();
  stub("menu_recommend");
  assert.equal(keywordRoute("今天天气真好"), null);
});

test("keywordRoute: skips rules pointing at disabled skills", () => {
  reset();
  stub("menu_recommend", false); // disabled
  // The 推荐 keyword matches but the skill is disabled → must return null.
  assert.equal(keywordRoute("推荐一款 IPA"), null);
});

test("keywordRoute: matches case-insensitively on English style names", () => {
  reset();
  stub("menu_recommend");
  const d = keywordRoute("I want a stout please");
  assert.ok(d);
  assert.equal(d!.skill_id, "menu_recommend");
  assert.equal((d!.params as { style: string }).style, "STOUT");
});