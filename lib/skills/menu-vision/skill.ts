import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const menuVisionSkill: SkillDefinition = {
  id: "menu-vision",
  name: "酒单视觉分析",
  description: "分析酒单/酒头照片，使用视觉模型做OCR识别、酒单分类、视觉质量检测，然后通过Untappd丰富数据。返回结构化酒单候选列表。这是 recommend skill 的内部依赖。",
  triggers: [],
  params: [],
  requiresImage: true,
  priority: 50, // lower priority — usually called internally by recommend
};

registerSkill(menuVisionSkill);
