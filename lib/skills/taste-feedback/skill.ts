import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const tasteFeedbackSkill: SkillDefinition = {
  id: "taste-feedback",
  name: "品饮反馈",
  description: "记录用户对喝过的啤酒的评价。解析评分(1-5分)、是否会再喝、风味标签(柑橘/热带水果/清爽/苦/甜等)，写入品饮记录并更新口味画像。",
  triggers: [
    "分", "会再喝", "不会再喝", "好喝", "不好喝", "喝了",
    "柑橘", "热带水果", "顺滑", "评分", "给分", "评价",
  ],
  params: [],
  requiresImage: false,
  priority: 20,
};

registerSkill(tasteFeedbackSkill);
