import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const beerKnowledgeSkill: SkillDefinition = {
  id: "beer-knowledge",
  name: "啤酒知识",
  description: "回答啤酒相关的专业知识问题：风格定义和区别(IPA vs 拉格)、酿造工艺(干投酒花)、酒厂历史、品饮技巧、啤酒文化。纯LLM回答，不查数据库。",
  triggers: [
    "什么是", "区别", "为什么", "怎么酿", "酿造", "发酵",
    "风格", "酒厂", "介绍一下", "讲讲", "是什么意思",
    "如何", "特点", "分类", "定义", "起源",
  ],
  params: [],
  requiresImage: false,
  priority: 35,
};

registerSkill(beerKnowledgeSkill);
