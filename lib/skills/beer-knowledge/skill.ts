import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const beerKnowledgeSkill: SkillDefinition = {
  id: "beer-knowledge",
  name: "啤酒知识",
  description: "以试酒师方式回答风格、工艺、酒厂与菜单追问；结合当前会话的来源化酒款档案和本地旧库参考，严格区分款级事实、风格通识与个人口味。",
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
