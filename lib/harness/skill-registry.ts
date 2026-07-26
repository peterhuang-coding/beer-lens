/**
 * Harness Skill Registry — default registrations for the 8 builtin skills.
 *
 * Each SkillId here is a 1:1 mirror of an entry in
 * `data/intent-registry.json`. The `invoke` body delegates to the existing
 * executor module under `lib/skills/*`, so the harness is purely additive:
 * it does not duplicate logic, it just standardises the entry point.
 *
 * Consumers can `import { invokeSkill } from "@/lib/harness/skill-registry"`
 * to get a one-stop dispatcher; nothing else needs to change.
 */

import { registerSkill, getSkill, listSkills, invokeSkill } from "./router.ts";
export { registerSkill, getSkill, listSkills, invokeSkill };

import type { Skill, SkillId, SkillContext } from "./types.ts";
import type { AgentContext } from "../agent/types.ts";

// ── Helpers ──

/**
 * Build an AgentContext from a SkillContext (so legacy executors that expect
 * AgentContext still work when called via the harness).
 */
function toAgentContext(ctx: SkillContext): AgentContext {
  if (ctx.agentContext) return ctx.agentContext;
  const req = ctx.request;
  const lastUserText = req.messages.at(-1)?.content ?? "";
  return {
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    traceId: `harness_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    hasImage: !!req.image?.dataUrl,
    imageDataUrl: req.image?.dataUrl,
    imageName: req.image?.name,
    imageType: req.image?.type,
    lastUserText,
    messages: req.messages,
    channel: req.channel,
  };
}

// ── Lazy executor factory ──
// Each entry dynamically imports its lib/skills/*/execute module on first use.
// This avoids a hard startup dependency and lets tests inject mocks later if
// needed by overwriting the registered Skill in the registry.

function makeExecutor(handlerPath: string) {
  return async (ctx: SkillContext) => {
    const agentCtx = toAgentContext(ctx);
    const mod = (await import(handlerPath)) as {
      execute: (ctx: AgentContext, params: Record<string, unknown>) =>
        Promise<import("./types").AgentReply>;
    };
    return mod.execute(agentCtx, ctx.params ?? {});
  };
}

// ── Default 8 builtin skills ──

const DEFAULT_SKILLS: ReadonlyArray<Omit<Skill, "invoke">> = [
  {
    id: "menu_recommend",
    label: "酒单推荐",
    description: "菜单/纯文字推荐（含图片酒单识别）",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/recommend/execute.ts",
  },
  {
    id: "follow_up_filter",
    label: "追问过滤",
    description: "基于活跃酒单的追问筛选（哪款/IPA/不苦/第3个等）",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/recommend/execute.ts",
  },
  {
    id: "tasting_feedback",
    label: "品饮反馈",
    description: "解析评分与风味标签，写入 episodic memory",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/taste-feedback/execute.ts",
  },
  {
    id: "profile_query",
    label: "画像查询",
    description: "查询用户口味画像（偏好风格/风味标签/ABV 区间）",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/profile-query/execute.ts",
  },
  {
    id: "beer_knowledge",
    label: "啤酒知识",
    description: "纯 LLM 回答啤酒风格/酿造/酒厂知识",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/beer-knowledge/execute.ts",
  },
  {
    id: "label_check",
    label: "酒标检查",
    description: "拍照单瓶 → 识别酒名/日期/新鲜度风险",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/label-check/execute.ts",
  },
  {
    id: "memory_correction",
    label: "记忆纠正",
    description: "纠正 AI 的错误记忆（酒名/偏好/记录）",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/memory-correction/execute.ts",
  },
  {
    id: "unclear",
    label: "意图不明",
    description: "无法识别意图时的兜底，引导用户说明需求",
    enabled: true,
    preferredHandler: "active",
    handlerFile: "../skills/fallback/execute.ts",
  },
];

// ── Self-registration on module load ──

let _registered = false;

function registerDefaults(): void {
  if (_registered) return;
  for (const def of DEFAULT_SKILLS) {
    registerSkill({
      ...def,
      invoke: makeExecutor(def.handlerFile),
    });
  }
  _registered = true;
}

// Side-effect: register on first import. Also exported for callers that want
// to force registration before reading `listSkills()`.
registerDefaults();

/**
 * Read-only descriptors for all built-in skills. Useful for CLI tools,
 * debug endpoints, and `data/skills/manifest.json` generation.
 */
export function describeBuiltinSkills() {
  return DEFAULT_SKILLS.map((s) => ({ ...s }));
}

// ── Convenience: list enabled ids, mirroring listEnabledSkillIds() in router
// but exposed through this module so callers don't need a second import.

export function listBuiltinSkillIds(): SkillId[] {
  return DEFAULT_SKILLS.filter((s) => s.enabled).map((s) => s.id);
}

// Re-export SkillContext type for consumers who'd rather pull it from here.
export type { Skill, SkillId, SkillContext };
