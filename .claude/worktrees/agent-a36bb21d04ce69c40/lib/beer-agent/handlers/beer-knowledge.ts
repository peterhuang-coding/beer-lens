import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { openrouterFetch } from "@/lib/beer-agent/openrouter-client";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";

const KNOWLEDGE_MODEL = process.env.OPENROUTER_ANALYSIS_MODEL ?? "openai/gpt-4o-mini";

export async function handleBeerKnowledge(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
  const lastUserText = request.messages.at(-1)?.content ?? "";
  const profileSummary = context.memorySnapshot?.profileSummary ?? "";
  const userId = request.userId;

  const history = request.messages
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
        { role: "user", content: `对话记录:\n${history}\n\n用户最新消息: ${lastUserText}` },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    return {
      mode: "recommend",
      reply: raw.trim() || "嗯，让我想想...",
      candidates: [],
      picks: emptyPicks(),
      profileSummary,
    };
  } catch (err) {
    console.warn("[beer-knowledge] LLM call failed:", err);
    return {
      mode: "recommend",
      reply: "抱歉，回答这个问题时出错了。请再试一次。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }
}
