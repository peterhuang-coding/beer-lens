/**
 * Harness LLM — reply composer.
 *
 * Given a deterministic skill result (or "no skill" decision), produce the
 * final user-facing text. The composer is intentionally optional: most of
 * the time the skill's own `reply` field is already a polished line. We
 * only call the composer when the reply needs natural-language framing,
 * e.g. wrapping a JSON result for end users.
 *
 * For v1 the composer is a thin pass — it re-emits the skill's reply plus a
 * short framing hint. We keep the prompt small so the cost stays low and
 * the model cannot hallucinate extra beers / facts.
 */

import type { AgentReply } from "../../types.ts";

export const REPLY_COMPOSER_INSTRUCTIONS = `你是 Beer Lens 的回复润色器。

任务:把 skill 的结构化结果改写成自然、口语化的中文短回复。
严格规则:
1. 不要新增 skill 结果里没有的事实、数字或啤酒名。
2. 不要重复 skill reply 的所有字 — 加一句过渡或上下文即可。
3. 长度 ≤ 80 个汉字。
4. 只输出最终回复文本,不要 JSON、不要 markdown。`;

export function buildReplyComposerMessages(
  userMessage: string,
  skillId: string,
  skillReply: AgentReply,
): Array<{ role: "system" | "user"; content: string }> {
  // Summarise the result so the model has shape, not a giant blob.
  const summary = {
    skillId: skillReply.skillId,
    reply: skillReply.reply,
    hasCandidates: skillReply.candidates.length > 0,
    hasPicks:
      skillReply.picks.topPick?.label !== "" ||
      skillReply.picks.safePick?.label !== "",
    profileSummary: skillReply.profileSummary?.slice(0, 200) ?? "",
  };
  return [
    { role: "system", content: REPLY_COMPOSER_INSTRUCTIONS },
    {
      role: "user",
      content:
        `用户消息: ${userMessage}\n` +
        `调用 skill: ${skillId}\n` +
        `skill 结构化结果: ${JSON.stringify(summary)}`,
    },
  ];
}