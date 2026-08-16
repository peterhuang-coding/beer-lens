/**
 * Harness LLM — tool registry.
 *
 * Generates OpenAI-compatible tool specs from the in-memory skill registry
 * so the model can decide which skill to call by name. Each tool's
 * parameters are derived from a static per-skill JSON Schema table (kept
 * here for v1 — a future version can read this from
 * `lib/skills/<cat>/profile.json`).
 *
 * Skill schemas are intentionally permissive (additionalProperties: true):
 * the deterministic executor is the source of truth for validation. If a
 * field is missing, the executor falls back gracefully.
 */

import { listSkills } from "../../router.ts";
import type { ToolSpec } from "../provider.ts";
import type { SkillId } from "../../types.ts";

// ── Per-skill JSON Schemas (v1) ──────────────────────────────────────────

const SCHEMAS: Record<SkillId, Record<string, unknown>> = {
  menu_recommend: {
    type: "object",
    properties: {
      style: { type: "string", description: "风格,如 NEIPA / Stout / Lager" },
      max_abv: { type: "number", description: "ABV 上限" },
      min_abv: { type: "number", description: "ABV 下限" },
      country: { type: "string", description: "国家偏好" },
      limit: { type: "integer", description: "返回数量", default: 5 },
      free_text: { type: "string", description: "用户的自由描述" },
    },
    additionalProperties: true,
  },
  follow_up_filter: {
    type: "object",
    properties: {
      style: { type: "string", description: "目标风格" },
      max_abv: { type: "number", description: "ABV 上限" },
      min_rating: { type: "number", description: "最低评分" },
      index: { type: "integer", description: "选第几个(从 1 开始)" },
      avoid: { type: "string", description: "要排除的属性,如 '苦' / '黑'" },
    },
    additionalProperties: true,
  },
  tasting_feedback: {
    type: "object",
    properties: {
      beer_name: { type: "string", description: "啤酒名(可选)" },
      sentiment: { type: "string", description: "positive / neutral / negative" },
      notes: { type: "string", description: "用户原文" },
    },
    additionalProperties: true,
  },
  profile_query: {
    type: "object",
    properties: {
      topic: { type: "string", description: "画像维度,如 '偏好风格' / '苦度'" },
    },
    additionalProperties: true,
  },
  beer_knowledge: {
    type: "object",
    properties: {
      question: { type: "string", description: "知识问题" },
    },
    required: ["question"],
    additionalProperties: true,
  },
  label_check: {
    type: "object",
    properties: {
      has_image: { type: "boolean", description: "用户是否上传了酒标图片" },
    },
    additionalProperties: true,
  },
  memory_correction: {
    type: "object",
    properties: {
      correction: { type: "string", description: "用户更正内容" },
    },
    required: ["correction"],
    additionalProperties: true,
  },
  unclear: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },
};

// ── Public ───────────────────────────────────────────────────────────────

/**
 * Build ToolSpecs for the LLM call. Filters out disabled skills so the
 * model never proposes them.
 */
export function buildToolSpecs(onlyEnabled = true): ToolSpec[] {
  return listSkills()
    .filter((s) => (onlyEnabled ? s.enabled : true))
    .map((s) => ({
      name: s.id,
      description: `${s.label} — ${s.description}`,
      parameters: SCHEMAS[s.id] ?? { type: "object", additionalProperties: true },
    }));
}

export const _internal = { SCHEMAS };