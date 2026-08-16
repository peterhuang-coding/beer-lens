/**
 * tests/llm-classifier.test.mts
 *
 * Unit tests for the intent classifier *parsing* helper and prompt
 * builder. We do not call the LLM here — only verify that JSON output is
 * accepted and that malformed model outputs degrade safely.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRouteDecision,
  buildIntentClassifierMessages,
  INTENT_CLASSIFIER_INSTRUCTIONS,
} from "../lib/harness/llm/prompts/intent-classifier.ts";
import { registerSkill } from "../lib/harness/router.ts";

test("parseRouteDecision: parses plain JSON", () => {
  const raw = '{"skill_id":"menu_recommend","params":{"style":"IPA"},"reason":"hoppy"}';
  const d = parseRouteDecision(raw);
  assert.ok(d);
  assert.equal(d!.skill_id, "menu_recommend");
  assert.deepEqual(d!.params, { style: "IPA" });
  assert.equal(d!.reason, "hoppy");
});

test("parseRouteDecision: parses 'none' for out-of-scope", () => {
  const d = parseRouteDecision('{"skill_id":"none","params":{},"reason":"chit-chat"}');
  assert.ok(d);
  assert.equal(d!.skill_id, "none");
});

test("parseRouteDecision: strips markdown code fences", () => {
  const raw = "```json\n{\"skill_id\":\"beer_knowledge\",\"params\":{\"question\":\"NEIPA是什么\"},\"reason\":\"知识问答\"}\n```";
  const d = parseRouteDecision(raw);
  assert.ok(d);
  assert.equal(d!.skill_id, "beer_knowledge");
});

test("parseRouteDecision: extracts JSON from surrounding prose", () => {
  const raw =
    '好的,我选这个: {"skill_id":"tasting_feedback","params":{"sentiment":"positive"},"reason":"用户说好喝"} 完毕';
  const d = parseRouteDecision(raw);
  assert.ok(d);
  assert.equal(d!.skill_id, "tasting_feedback");
  assert.equal(d!.params.sentiment, "positive");
});

test("parseRouteDecision: returns null on total garbage", () => {
  assert.equal(parseRouteDecision("I don't know how to answer that"), null);
});

test("parseRouteDecision: defaults params to {} when missing", () => {
  const d = parseRouteDecision('{"skill_id":"beer_knowledge"}');
  assert.ok(d);
  assert.deepEqual(d!.params, {});
  assert.equal(d!.reason, "");
});

test("buildIntentClassifierMessages: includes the user message and the system prompt", () => {
  // Register one stub skill so the roster is non-empty.
  registerSkill({
    id: "menu_recommend",
    label: "酒单推荐",
    description: "menu test stub",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "test.ts",
    invoke: async () => ({
      skillId: "menu_recommend",
      reply: "x",
      candidates: [],
      picks: { topPick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 }, safePick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 }, explorePick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 }, avoidOrCaution: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 } },
      profileSummary: "",
      errors: [],
    }),
  });

  const msgs = buildIntentClassifierMessages("推荐一款 IPA");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.equal(msgs[1].content, "推荐一款 IPA");
  // System prompt carries the roster and the instructions header.
  assert.match(msgs[0].content, /menu_recommend/);
  assert.match(msgs[0].content, new RegExp(INTENT_CLASSIFIER_INSTRUCTIONS.slice(0, 30)));
});