import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

const KNOWLEDGE_MODEL = process.env.OPENROUTER_ANALYSIS_MODEL ?? "qwen/qwen-2.5-72b-instruct";

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  const { openrouterFetch } = await import("@/lib/beer-agent/openrouter-client");
  const profileSummary = ctx.profileSummary ?? "";

  const history = ctx.messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const systemPrompt = `你是 Beer Lens，一个懂啤酒的 AI 助手。

## 你的能力
- 回答啤酒知识问题（风格、酒厂、酿造工艺）
- 分析用户口味偏好
- 讨论啤酒文化和品饮技巧

## 用户画像
${profileSummary || "暂无品饮记录"}

## 规则
- 用中文回答，自然随意，像朋友聊天
- 如果用户问风格/知识问题，直接用你的知识回答
- 不要编造具体酒名，除非从上下文中已有信息
- 如果没有足够信息，诚实说，不要编造`;

  try {
    const raw = await openrouterFetch({
      model: KNOWLEDGE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `对话记录:\n${history}\n\n用户最新消息: ${ctx.lastUserText}` },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    return {
      skillId: "beer-knowledge",
      reply: raw.trim() || "嗯，让我想想...",
      candidates: [],
      picks: emptyPicks(),
      profileSummary,
      errors: [],
    };
  } catch (err) {
    return {
      skillId: "beer-knowledge",
      reply: "抱歉，回答这个问题时出错了。请再试一次。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
