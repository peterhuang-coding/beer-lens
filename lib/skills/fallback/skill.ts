import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const fallbackSkill: SkillDefinition = {
  id: "fallback",
  name: "兜底处理",
  description: "当用户意图不明确或LLM无法选择合适的技能时使用的兜底处理。引导用户说明需求（推荐啤酒、记录反馈、知识问答等）。",
  triggers: [],
  params: [],
  requiresImage: false,
  priority: 99,
};

registerSkill(fallbackSkill);
