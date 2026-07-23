import { registerSkill } from "@/lib/agent/skill-registry";
import type { SkillDefinition } from "@/lib/agent/types";

export const profileQuerySkill: SkillDefinition = {
  id: "profile-query",
  name: "口味画像查询",
  description: "查询用户的口味画像：偏好风格、风味标签、ABV舒适区间、品饮记录数量、画像置信度、近期趋势。当用户问「我的口味」「我喝过什么」「我的偏好」时使用。",
  triggers: [
    "我的口味", "我喜欢什么", "画像", "喝过什么", "口味偏好",
    "偏好", "我的记录", "品饮记录", "看我口味",
    "适合什么风格", "风格偏好", "喜欢什么风格",
  ],
  params: [],
  requiresImage: false,
  priority: 25,
};

registerSkill(profileQuerySkill);
