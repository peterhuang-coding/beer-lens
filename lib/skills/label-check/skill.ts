import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const labelCheckSkill: SkillDefinition = {
  id: "label-check",
  name: "酒标检查",
  description: "分析单瓶/单罐啤酒的酒标照片。识别酒名、酒厂、风格、ABV、生产日期/包装日期、新鲜度评估、酒标是否有褪色/破损等问题。",
  triggers: [
    "酒标", "生产日期", "过期", "这瓶", "这罐", "这是啥酒",
    "这是哪款酒", "这是什么酒", "看看这瓶", "检查日期",
    "保质期", "新鲜度", "还能喝吗", "放了多久",
  ],
  params: [],
  requiresImage: true,
  priority: 15,
};

registerSkill(labelCheckSkill);
