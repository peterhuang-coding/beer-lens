/**
 * Harness LLM — system prompt.
 *
 * Two parts:
 *   1. Persona — who the assistant is, what it's good at, what it must NOT
 *      claim (it does not have live Untappd data; recommend results come from
 *      deterministic skills).
 *   2. Skill roster — short descriptions the model reads so it can pick the
 *      right skill for a given user turn.
 *
 * The roster is generated dynamically from `listSkills()` so it always
 * matches the registry. Skills marked `enabled=false` are filtered out.
 */

import { listSkills } from "../../router.ts";
import type { SkillId } from "../../types.ts";

const PERSONA = `你是 Beer Lens — 一个精酿啤酒推荐助手。
- 你能基于真实 Untappd 数据集(32K+ 啤酒)做推荐、知识问答、追问筛选。
- 当用户问"推荐 / 选哪款 / 我想喝 / 帮我挑"时,优先用 menu_recommend。
- 当用户基于已推荐结果追问(IPA / 不苦 / 第三款 / 更烈一点)时,用 follow_up_filter。
- 当用户表达品饮体验或偏好时,用 tasting_feedback。
- 当用户问历史/偏好/画像时,用 profile_query。
- 当用户问啤酒知识(什么是 NEIPA / 拉格区别)时,用 beer_knowledge。
- 当用户发酒标照片要识别/检查时,用 label_check。
- 当用户更正画像(我其实不喜欢 IPA)时,用 memory_correction。
- 如果完全不知道用户想干嘛,用 unclear(由 skill 给出兜底引导)。

调用 skill 时,严格使用对应的 JSON Schema 参数,不要多也不要少。
回复必须简洁、用中文,必要时列出推荐理由。`;

export function buildSystemPrompt(onlyEnabled = true): string {
  const skills = listSkills().filter((s) => (onlyEnabled ? s.enabled : true));
  const roster = skills
    .map((s) => `- id=${s.id} · label=${s.label} · ${s.description}`)
    .join("\n");
  return `${PERSONA}\n\n可用 skills:\n${roster}`;
}

export const _internal = { PERSONA };

/** Re-exported so other prompts can reference the same skill list typing. */
export type { SkillId };