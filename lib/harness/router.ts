/**
 * Harness Router — single invoke() entry for every Skill in the registry.
 *
 * The router stores skills in an in-memory Map keyed by SkillId. All public
 * functions are pure (no I/O), so they are safe to call from any module
 * without side effects beyond what's explicitly registered.
 *
 * Usage:
 *   registerSkill({ id: "menu_recommend", invoke: ... });
 *   const reply = await invokeSkill("menu_recommend", ctx);
 */

import type { Skill, SkillId, SkillContext, AgentReply } from "./types";

// ── In-memory registry ──

const skills = new Map<SkillId, Skill>();

// ── Registration ──

export function registerSkill(s: Skill): void {
  if (skills.has(s.id)) {
    // Last-registration wins. Warning lets us spot misconfiguration.
    console.warn(`[harness] overwriting skill "${s.id}"`);
  }
  skills.set(s.id, { ...s });
}

export function unregisterSkill(id: SkillId): boolean {
  return skills.delete(id);
}

export function getSkill(id: SkillId): Skill | undefined {
  return skills.get(id);
}

export function listSkills(): Skill[] {
  return [...skills.values()];
}

export function listEnabledSkillIds(): SkillId[] {
  return [...skills.values()].filter((s) => s.enabled).map((s) => s.id);
}

// ── Error shape returned by invokeSkill for disabled/unknown skills ──

export type InvokeError = {
  ok: false;
  error: "unknown_skill" | "skill_disabled";
  skill: SkillId;
  message: string;
};

export type InvokeOk = { ok: true } & AgentReply;

export type InvokeResult = InvokeOk | InvokeError;

// ── Single invoke() entry ──

/**
 * Dispatch a skill by id. The router is the ONLY supported way to run a skill
 * from inside the harness — callers must not import lib/skills/* directly.
 *
 * Behavior:
 *   - Unknown id         → throws `UnknownSkillError`
 *   - Known but disabled → returns `{ ok:false, error:"skill_disabled", ... }`
 *   - Known + enabled    → returns `{ ok:true, ...reply }`
 *
 * The non-throwing disabled case lets the controller fall back gracefully
 * without try/catch noise.
 */
export async function invokeSkill(
  id: SkillId,
  ctx: SkillContext,
): Promise<InvokeResult> {
  const skill = getSkill(id);
  if (!skill) {
    throw new UnknownSkillError(id);
  }
  if (!skill.enabled) {
    return {
      ok: false,
      error: "skill_disabled",
      skill: id,
      message: `Skill "${id}" is currently disabled.`,
    };
  }
  const reply = await skill.invoke(ctx);
  return { ok: true, ...reply };
}

// ── Errors ──

export class UnknownSkillError extends Error {
  readonly id: SkillId;
  constructor(id: SkillId) {
    super(`Unknown skill: ${id}`);
    this.id = id;
    this.name = "UnknownSkillError";
  }
}
