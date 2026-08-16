/**
 * tests/llm-tools.test.mts
 *
 * Unit tests for the skill → tool-schema generator. Verifies that every
 * registered skill id has a JSON Schema and that disabled skills are
 * hidden from the model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolSpecs } from "../lib/harness/llm/tools/registry.ts";
import { registerSkill, listSkills, _resetSkillsForTests } from "./_helpers/router-test-helper.ts";

function resetAndRegisterDefaults(): void {
  _resetSkillsForTests();
  const ids = ["menu_recommend", "follow_up_filter", "tasting_feedback", "profile_query",
               "beer_knowledge", "label_check", "memory_correction", "unclear"] as const;
  for (const id of ids) {
    registerSkill({
      id,
      label: id,
      description: `${id} stub`,
      enabled: id !== "memory_correction",
      preferredHandler: "active",
      handlerFile: `stub/${id}.ts`,
      invoke: async () => ({
        skillId: id,
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
      }),
    });
  }
}

test("buildToolSpecs: yields one tool per enabled skill with required shape", () => {
  resetAndRegisterDefaults();
  const tools = buildToolSpecs(true);
  // 7 enabled, 1 disabled (memory_correction) — must be absent.
  assert.equal(tools.length, 7);
  for (const t of tools) {
    assert.equal(typeof t.name, "string");
    assert.match(t.description, /stub/);
    assert.equal((t.parameters as { type?: string }).type, "object");
  }
  assert.ok(!tools.some((t) => t.name === "memory_correction"));
});

test("buildToolSpecs: includes disabled skills when enabledOnly=false", () => {
  resetAndRegisterDefaults();
  const tools = buildToolSpecs(false);
  assert.equal(tools.length, 8);
  assert.ok(tools.some((t) => t.name === "memory_correction"));
});

test("buildToolSpecs: beer_knowledge requires the 'question' param", () => {
  resetAndRegisterDefaults();
  const tools = buildToolSpecs(true);
  const kn = tools.find((t) => t.name === "beer_knowledge")!;
  const req = (kn.parameters as { required?: string[] }).required ?? [];
  assert.ok(req.includes("question"));
});

test("buildToolSpecs: stays in sync with the skill registry", () => {
  resetAndRegisterDefaults();
  const registered = listSkills().filter((s) => s.enabled).map((s) => s.id).sort();
  const tools = buildToolSpecs(true).map((t) => t.name).sort();
  assert.deepEqual(tools, registered);
});