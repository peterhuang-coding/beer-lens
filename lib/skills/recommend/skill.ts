/**
 * Recommend Skill — beer recommendation from text or menu photos.
 */
import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const recommendSkill: SkillDefinition = {
  id: "recommend",
  name: "啤酒推荐",
  description: "给用户推荐啤酒。分析酒单照片或根据用户文字描述（风格、口味偏好）推荐最佳选择。支持「帮我推荐IPA」「今天喝什么」「拍酒单推荐」等场景。",
  triggers: [
    "推荐", "帮我推荐", "帮我选", "帮我挑", "喝什么", "酒单",
    "帮我看看", "有什么推荐", "推荐一款", "今天喝什么好",
    "想喝", "帮我看看酒单", "给我推荐", "下一杯", "再来一杯",
    "换口味", "试试", "尝新", "挑一款", "帮我搭配",
  ],
  params: [
    { name: "style", type: "string", description: "用户偏好的啤酒风格（IPA、拉格、世涛等）" },
    { name: "constraints", type: "string[]", description: "用户约束（清爽、不苦、便宜等）" },
  ],
  requiresImage: false, // supports both text and image
  priority: 10,
};

// Self-register on import
registerSkill(recommendSkill);
