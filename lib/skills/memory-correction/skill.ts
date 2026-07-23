import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const memoryCorrectionSkill: SkillDefinition = {
  id: "memory-correction",
  name: "记忆纠正",
  description: "处理用户对AI记忆的纠正。当用户说「不是这个」「记错了」「纠正一下」「应该是」「改成」时使用。解析纠正内容，应用于口味画像，返回确认。也支持清空/重置记忆。",
  triggers: [
    "不是", "纠正", "记错", "应该是", "改成", "不对",
    "更爱", "其实是", "说错了", "更正", "改一下",
    "清空", "清除", "重置", "清掉", "reset",
  ],
  params: [],
  requiresImage: false,
  priority: 40,
};

registerSkill(memoryCorrectionSkill);
