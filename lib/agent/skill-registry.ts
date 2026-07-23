/**
 * Skill Registry — registers, discovers, and describes skills for the Agent Controller.
 *
 * Skills are discovered by scanning `lib/skills/` at startup.
 * Each skill folder exports its SkillDefinition from `skill.ts`.
 *
 * The registry can also generate a prompt snippet that the LLM uses
 * to decide which skill to invoke.
 */

import type { SkillDefinition } from "./types";

// ── In-memory registry ──

const registry = new Map<string, SkillDefinition>();

// ── Registration ──

export function registerSkill(def: SkillDefinition): void {
  if (registry.has(def.id)) {
    console.warn(`[skill-registry] Overwriting skill "${def.id}"`);
  }
  registry.set(def.id, { ...def });
}

export function unregisterSkill(id: string): boolean {
  return registry.delete(id);
}

export function getSkill(id: string): SkillDefinition | undefined {
  return registry.get(id);
}

export function getAllSkills(): SkillDefinition[] {
  return [...registry.values()].sort((a, b) => a.priority - b.priority);
}

// ── Prompt Generation ──

/**
 * Build the skill selection prompt for the LLM.
 * The LLM reads this and returns a SkillSelection JSON.
 */
export function buildSkillPrompt(hasImage: boolean): string {
  const skills = getAllSkills();
  if (skills.length === 0) return "";

  const lines: string[] = [
    "你是 Beer Lens 的技能调度器。根据用户的输入，选择最合适的技能来处理。",
    "",
    "## 可用技能",
    "",
  ];

  for (const skill of skills) {
    const imageTag = skill.requiresImage ? "[需要图片]" : "";
    lines.push(`### ${skill.id} — ${skill.name} ${imageTag}`);
    lines.push(`- ${skill.description}`);
    if (skill.triggers.length > 0) {
      lines.push(`- 典型场景：${skill.triggers.slice(0, 5).join("、")}`);
    }
    if (skill.params.length > 0) {
      const paramStrs = skill.params.map(
        (p) => `${p.name}: ${p.type}${p.required ? "(必填)" : "(可选)"} — ${p.description}`
      );
      lines.push(`- 参数：${paramStrs.join("; ")}`);
    }
    lines.push("");
  }

  lines.push(
    "## 规则",
    "- 只返回 JSON，不要返回其他内容",
    '- 格式：{"skill": "<skill_id>", "reason": "<为什么选这个>", "params": {}}',
    "- 如果用户的意图不明确，选择 fallback",
    "- 如果有图片且文字是问单瓶/酒标，选择 label-check",
    "- 如果有图片且文字是推荐/酒单相关，选择 recommend",
    "- 如果用户给啤酒打分/说好不好喝，选择 taste-feedback",
    "- 如果用户问自己的口味/偏好/记录，选择 profile-query",
    "- 如果用户说「不是」「记错了」「纠正」之类，选择 memory-correction",
    "- 如果用户问啤酒风格/酿造/知识问题，选择 beer-knowledge",
    `- 当前${hasImage ? "有" : "没有"}图片`,
  );

  return lines.join("\n");
}

// ── Parse LLM Skill Selection ──

/**
 * Parse the LLM's response into a SkillSelection.
 * Handles common LLM output issues (markdown fences, extra text).
 */
export function parseSkillSelection(raw: string): {
  skill: string;
  reason: string;
  params: Record<string, unknown>;
} {
  // Strip markdown fences
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  // Find JSON object
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON found in LLM response: ${raw.slice(0, 200)}`);
  }

  const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));

  if (!parsed.skill || typeof parsed.skill !== "string") {
    throw new Error(`Missing or invalid "skill" field in: ${JSON.stringify(parsed)}`);
  }

  return {
    skill: parsed.skill,
    reason: parsed.reason ?? "",
    params: parsed.params ?? {},
  };
}

// ── Skill Discovery ──

/**
 * Discover and register all skills from the lib/skills/ directory.
 * Called once at startup.
 *
 * Skills are discovered by static imports — each skill module
 * calls registerSkill() at module load time.
 * This function imports all known skill modules.
 */
export async function discoverSkills(): Promise<void> {
  // Each skill module self-registers on import.
  // We import them all to trigger registration.
  await Promise.allSettled([
    import("@/lib/skills/recommend/skill"),
    import("@/lib/skills/taste-feedback/skill"),
    import("@/lib/skills/beer-knowledge/skill"),
    import("@/lib/skills/label-check/skill"),
    import("@/lib/skills/profile-query/skill"),
    import("@/lib/skills/memory-correction/skill"),
    import("@/lib/skills/menu-vision/skill"),
    import("@/lib/skills/fallback/skill"),
  ]);
}

// ── Initialize ──

let _initialized = false;

export async function ensureSkillsLoaded(): Promise<void> {
  if (_initialized) return;
  await discoverSkills();
  _initialized = true;
}
