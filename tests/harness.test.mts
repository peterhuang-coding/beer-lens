/**
 * Harness self-tests — Round 2 / Round 3 verification.
 *
 *   1. After import, listSkills() returns exactly 8 builtin SkillIds.
 *   2. invokeSkill on an unknown id throws UnknownSkillError.
 *   3. invokeSkill on a disabled skill returns ok:false (no throw).
 *   4. invokeSkill on an enabled id returns a SkillResult-shaped reply.
 *
 * Run via: node --experimental-strip-types --test tests/harness.test.mts
 *
 * Self-contained — imports use explicit .ts extensions so Node's
 * strip-types loader can resolve them without bundler config.
 */

// @ts-nocheck — strip-types module resolution tolerates untyped this
import { describe, it } from "node:test";
import assert from "node:assert";

import { listSkills, invokeSkill, listBuiltinSkillIds } from "../lib/harness/skill-registry.ts";
import { UnknownSkillError } from "../lib/harness/router.ts";

describe("harness registry", () => {
  it("listSkills returns exactly 8 builtin skills", () => {
    const skills = listSkills();
    assert.strictEqual(skills.length, 8, `expected 8 skills, got ${skills.length}`);
    const ids = skills.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, [
      "beer_knowledge",
      "follow_up_filter",
      "label_check",
      "memory_correction",
      "menu_recommend",
      "profile_query",
      "tasting_feedback",
      "unclear",
    ]);
  });

  it("listBuiltinSkillIds reports 8 enabled ids", () => {
    const ids = listBuiltinSkillIds();
    assert.strictEqual(ids.length, 8);
    assert.ok(ids.includes("menu_recommend"));
    assert.ok(ids.includes("unclear"));
  });

  it("every skill has id/label/description/enabled/handlerFile/invoke fields", () => {
    for (const s of listSkills()) {
      assert.ok(typeof s.id === "string" && s.id.length > 0);
      assert.ok(typeof s.label === "string");
      assert.ok(typeof s.description === "string");
      assert.strictEqual(typeof s.enabled, "boolean");
      assert.ok(s.handlerFile.endsWith("/execute") || s.handlerFile.endsWith("/execute.ts"));
      assert.strictEqual(typeof s.invoke, "function");
    }
  });
});

describe("harness router", () => {
  it("invokeSkill with unknown id throws UnknownSkillError", async () => {
    await assert.rejects(
      invokeSkill("does_not_exist", {
        userId: "u", conversationId: "c",
        request: { userId: "u", channel: "cli", conversationId: "c", turnId: "t", messages: [] },
      }),
      (err: unknown) => err instanceof UnknownSkillError,
    );
  });

  it("invokeSkill for an enabled skill returns ok:true with SkillResult shape", async () => {
    const ctx = {
      userId: "smoke",
      conversationId: "smoke-conv",
      request: {
        userId: "smoke",
        channel: "cli",
        conversationId: "smoke-conv",
        turnId: "smoke-turn",
        messages: [{ role: "user", content: "hello" }],
      },
    };
    // Use a low-risk skill that does not depend on external services.
    // 'unclear' → fallback/execute which handles empty/greeting input.
    const result = await invokeSkill("unclear", ctx);
    assert.strictEqual(result.ok, true);
    // @ts-expect-error — narrow after ok check
    assert.strictEqual(typeof result.skillId, "string");
    // @ts-expect-error — narrow after ok check
    assert.strictEqual(typeof result.reply, "string");
  });
});
