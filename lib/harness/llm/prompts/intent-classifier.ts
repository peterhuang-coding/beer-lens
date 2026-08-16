/**
 * Harness LLM — intent classifier prompt.
 *
 * The classifier is the "router" half of the LLM-as-Router pattern. It
 * reads the user message + skill roster and decides which skill to invoke
 * (if any) and with which parameters.
 *
 * Output contract (strict JSON — the model is told to refuse prose):
 *
 *   {
 *     "skill_id": "menu_recommend",
 *     "params":   { "style": "IPA", "max_abv": 7 },
 *     "reason":   "user asks for a hoppy beer under 7% ABV"
 *   }
 *
 *   // or, when no skill fits:
 *   { "skill_id": "none", "params": {}, "reason": "..." }
 *
 * "none" tells the harness to skip `invokeSkill` and let the reply composer
 * answer directly (useful for greetings / chit-chat).
 */

import { listSkills } from "../../router.ts";
import type { ToolSpec } from "../provider.ts";

export const INTENT_CLASSIFIER_INSTRUCTIONS = `你是 Beer Lens 的意图路由器。

任务:读取用户的最近一条消息,从给定的 skill 列表里选最匹配的一个,并抽取它需要的参数。

硬性规则(违反任意一条视为失败):
1. 只输出一个 JSON 对象,不要任何解释、不要 markdown 代码块、不要前后缀。
2. JSON 必须严格形如: {"skill_id": "<id|none>", "params": {...}, "reason": "一句话"}
3. skill_id 只能从下面"可用 skills"列表中精确复制 — 包括大小写、下划线、连字符都不许改。
   不许自创、不许翻译、不许改大小写、不许加前缀(如不要 "beer_" 前缀)。
4. 如果不属于任何 skill(如单纯问候、闲聊),skill_id 必须设为 "none"。
5. params 必须符合该 skill 的 JSON Schema,只填真正用得到的字段。
6. reason 用一句话(≤30 个汉字)说明理由,不要解释推理过程。`;

/**
 * Build the classifier message list:
 *   system: instructions + skill roster
 *   user:   the actual user message
 *
 * We do NOT include conversation history in v1 — single-turn routing keeps
 * the prompt small and the behaviour predictable. Multi-turn memory is a
 * separate scope.
 */
export function buildIntentClassifierMessages(
  userMessage: string,
  onlyEnabled = true,
): Array<{ role: "system" | "user"; content: string }> {
  const skills = listSkills().filter((s) => (onlyEnabled ? s.enabled : true));
  const roster = skills
    .map(
      (s, i) =>
        `${i + 1}. id=${s.id}\n   label=${s.label}\n   description=${s.description}`,
    )
    .join("\n\n");

  // Build an explicit "VALID IDs" line so the model cannot miss it even
  // if it ignores the roster. Reasoning models tend to summarise the
  // roster into a synonym ("beer_recommend") and lose fidelity — this
  // pattern catches them.
  const validIds = skills.map((s) => s.id).join(", ");

  return [
    {
      role: "system",
      content:
        `${INTENT_CLASSIFIER_INSTRUCTIONS}\n\n` +
        `可用 skills(必须严格使用以下 id,不能改写):\n${roster}\n\n` +
        `合法 skill_id 取值: [${validIds}]\n\n` +
        `可选:"none" 表示跳过 skill、直接对话。`,
    },
    { role: "user", content: userMessage.trim() },
  ];
}

/** Schema describing the classifier's expected JSON output. */
export const INTENT_CLASSIFIER_SCHEMA: ToolSpec = {
  name: "route_intent",
  description: "Pick the best skill for the user's message.",
  parameters: {
    type: "object",
    properties: {
      skill_id: { type: "string", description: "skill id or 'none'" },
      params: { type: "object", description: "parameters for the chosen skill" },
      reason: { type: "string", description: "one-line justification" },
    },
    required: ["skill_id"],
  },
};

// ── Parsing helpers ──────────────────────────────────────────────────────

export interface RouteDecision {
  skill_id: string;
  params: Record<string, unknown>;
  reason: string;
}

/**
 * Parse the model's raw output into a RouteDecision. The model is told to
 * output JSON only, but in practice it sometimes wraps it in code fences or
 * prefixes a sentence. We try a few tolerant extractions before failing.
 */
export function parseRouteDecision(raw: string): RouteDecision | null {
  const trimmed = raw.trim();
  // Try direct parse.
  let parsed: unknown = tryJson(trimmed);
  // Strip code fences if present.
  if (parsed === null) {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fence) parsed = tryJson(fence[1]);
  }
  // Find the first {...} block.
  if (parsed === null) {
    const brace = trimmed.match(/\{[\s\S]*\}/);
    if (brace) parsed = tryJson(brace[0]);
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const skillId = typeof obj.skill_id === "string" ? obj.skill_id : "none";
  const params =
    obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {};
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { skill_id: skillId, params, reason };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}