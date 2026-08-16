/**
 * Skill toggle + detail endpoints — unit tests.
 *
 *   1. setSkillEnabled round-trip
 *   2. writeManifestAtomic + concurrent-tolerance
 *   3. setSkillEnabled throws SkillNotFoundError for unknown id (endpoint 404)
 *   4. router skips a disabled skill via invokeSkill
 *
 * Run via:
 *   node --experimental-strip-types --test tests/skill-toggle-detail.test.mts
 *
 * The atomic-write test is deterministic: it checks that after two concurrent
 * writes the file is still valid JSON with non-zero content (rather than
 * trying to emulate POSIX rename atomicity, which is a property of the
 * filesystem, not Node).
 */

// @ts-nocheck — strip-types module resolution tolerates untyped this
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readManifest,
  setSkillEnabled,
  writeManifestAtomic,
  SkillNotFoundError,
} from "../lib/skills/manifest-helper.ts";
import {
  registerSkill,
  unregisterSkill,
  invokeSkill,
  listSkills,
} from "../lib/harness/router.ts";
import type { Skill, SkillContext } from "../lib/harness/types.ts";

const FIXTURE_MANIFEST = {
  version: 1,
  name: "test-fixture",
  description: "unit-test fixture",
  defaultEnabled: ["alpha", "beta"],
  skills: [
    { id: "alpha", label: "Alpha", description: "a", handlerFile: "lib/skills/a/execute.ts", preferred: "active", enabled: true },
    { id: "beta", label: "Beta", description: "b", handlerFile: "lib/skills/b/execute.ts", preferred: "active", enabled: true },
  ],
  updatedAt: "2026-01-01T00:00:00Z",
};

// ── 1. setSkillEnabled round-trip ────────────────────────────────────────

describe("setSkillEnabled", () => {
  it("flips a known skill and leaves siblings untouched", () => {
    const a = setSkillEnabled(FIXTURE_MANIFEST, "alpha", false);
    const alpha = a.skills.find((s) => s.id === "alpha")!;
    const beta = a.skills.find((s) => s.id === "beta")!;
    assert.strictEqual(alpha.enabled, false, "alpha should be flipped to false");
    assert.strictEqual(beta.enabled, true, "beta should be unchanged");
    // input must not be mutated
    assert.strictEqual(FIXTURE_MANIFEST.skills.find((s) => s.id === "alpha")!.enabled, true);

    // round-trip back
    const a2 = setSkillEnabled(a, "alpha", true);
    assert.strictEqual(a2.skills.find((s) => s.id === "alpha")!.enabled, true);
  });

  it("refreshes updatedAt on every call", () => {
    const before = FIXTURE_MANIFEST.updatedAt!;
    const next = setSkillEnabled(FIXTURE_MANIFEST, "alpha", false);
    assert.notStrictEqual(next.updatedAt, before, "updatedAt must change");
    assert.match(next.updatedAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ISO 8601");
  });

  it("throws SkillNotFoundError for unknown id", () => {
    assert.throws(
      () => setSkillEnabled(FIXTURE_MANIFEST, "does_not_exist", false),
      (err: unknown) => err instanceof SkillNotFoundError && err.id === "does_not_exist",
    );
  });
});

// ── 2. atomic write + concurrent tolerance ──────────────────────────────

describe("writeManifestAtomic", () => {
  let workDir: string;
  let filePath: string;

  before(async () => {
    workDir = await mkTmpDir("beer-lens-atomic-");
    filePath = join(workDir, "manifest.json");
  });

  after(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("writes a valid JSON file the reader can parse", async () => {
    await writeManifestAtomic(filePath, FIXTURE_MANIFEST);
    const back = await readManifest(filePath);
    assert.deepStrictEqual(back.skills.length, 2);
    assert.strictEqual(back.skills[0].id, "alpha");
  });

  it("succeeds under concurrent writers without producing a corrupt file", async () => {
    // Reset
    await writeManifestAtomic(filePath, FIXTURE_MANIFEST);

    // Two writers, each flipping a different skill. Either outcome is fine
    // (last-write-wins); the file must remain parseable JSON with nonzero size.
    const writerA = async () => {
      const m = await readManifest(filePath);
      await writeManifestAtomic(filePath, setSkillEnabled(m, "alpha", false));
    };
    const writerB = async () => {
      const m = await readManifest(filePath);
      await writeManifestAtomic(filePath, setSkillEnabled(m, "beta", false));
    };
    await Promise.all([writerA(), writerB()]);

    const st = await stat(filePath);
    assert.ok(st.size > 0, "manifest must not be empty after concurrent writes");
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.skills.length, 2);

    // No stale .tmp files left behind (best-effort cleanup is in the helper).
    const entries = await (await import("node:fs/promises")).readdir(workDir);
    const leftover = entries.filter((n) => n.includes(".tmp."));
    assert.strictEqual(leftover.length, 0, `no stale tmp files: ${leftover.join(", ")}`);
  });
});

// ── 3. route handler 404 path (via helper) ──────────────────────────────

describe("API route 404 path", () => {
  it("returns SkillNotFoundError for an id that is not in the manifest", () => {
    // The API route at /api/skills/[id]/toggle uses the same setSkillEnabled
    // path. The contract: an unknown id must surface SkillNotFoundError so
    // the route can translate it to a 404 with {error:"skill not found"}.
    let caught: unknown = null;
    try {
      setSkillEnabled(FIXTURE_MANIFEST, "no_such_skill", false);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SkillNotFoundError, "must throw SkillNotFoundError");
    assert.strictEqual((caught as SkillNotFoundError).id, "no_such_skill");
  });
});

// ── 4. router skips disabled skill ───────────────────────────────────────

describe("router skips disabled skills", () => {
  const id = "test_disabled_skill";

  // stub executor that should NEVER fire when the skill is disabled
  const stubInvoke = async () => {
    throw new Error("disabled skill should not be invoked");
  };

  before(() => {
    unregisterSkill(id); // clean any prior residue
    const skill: Skill = {
      id: id as Skill["id"],
      label: "Disabled Test",
      description: "disabled test fixture",
      enabled: false,
      preferredHandler: "active",
      handlerFile: "lib/skills/_test/execute.ts",
      invoke: stubInvoke,
    };
    registerSkill(skill);
  });

  after(() => {
    unregisterSkill(id);
  });

  it("invokeSkill returns {ok:false, error:'skill_disabled'} for a disabled skill", async () => {
    const ctx = {
      userId: "u",
      conversationId: "c",
      request: {
        userId: "u",
        channel: "cli",
        conversationId: "c",
        turnId: "t",
        messages: [{ role: "user", content: "hi" }],
      },
    } as unknown as SkillContext;

    const result = await invokeSkill(id as Skill["id"], ctx);
    assert.strictEqual(result.ok, false, "ok must be false for disabled skill");
    // @ts-expect-error — narrow after ok check
    assert.strictEqual(result.error, "skill_disabled");
    // @ts-expect-error
    assert.strictEqual(result.skill, id);
  });

  it("listEnabledSkillIds() across the in-memory registry excludes the disabled one", () => {
    const enabledIds = listSkills()
      .filter((s) => s.enabled)
      .map((s) => s.id);
    assert.ok(!enabledIds.includes(id), `disabled id '${id}' must not be in enabled list`);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
