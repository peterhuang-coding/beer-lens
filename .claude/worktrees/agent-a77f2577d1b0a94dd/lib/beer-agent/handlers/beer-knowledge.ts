import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { openrouterFetch } from "@/lib/beer-agent/openrouter-client";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";
import { getModelConfig, type PromptConfig } from "@/lib/beer-agent/orchestrator";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

async function loadConfig(): Promise<any> {
  try { const raw = await readFile(CONFIG_PATH, "utf8"); return JSON.parse(raw); }
  catch { return {}; }
}

async function getPromptContent(id: string, fallback: string): Promise<string> {
  const cfg = await loadConfig();
  return cfg.prompts?.[id]?.content ?? fallback;
}

function fallbackKnowledgeReply(text: string): string {
  if (/west\s*coast\s*ipa|西海岸\s*ipa/i.test(text)) {
    return "West Coast IPA 是 IPA 里偏干、偏清爽、酒花香气更锋利的一支。它通常突出松针、柑橘皮、葡萄柚这类香气，苦味更直接，收口比较干净；和 Hazy IPA 相比，它没那么浑浊甜润，果汁感更少，酒花的苦和香会更清晰。";
  }
  if (/什么是\s*IPA|IPA.*什么/i.test(text)) {
    return "IPA 是 India Pale Ale，核心特点是酒花香气和苦味更突出。常见香气有柑橘、热带水果、松针、花香，不同分支会差很多：West Coast IPA 更干更苦，Hazy IPA 更柔和多汁，Session IPA 更轻盈易饮。";
  }
  return "抱歉，模型暂时没能回答这个问题。你可以换个问法，或者直接问某个风格，比如“什么是 West Coast IPA”。";
}

export async function handleBeerKnowledge(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
  const lastUserText = request.messages.at(-1)?.content ?? "";
  const profileSummary = context.memorySnapshot?.profileSummary ?? "";

  const history = request.messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const fallbackPrompt = `你是 Beer Lens，一个懂啤酒的 AI 助手。

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

  const systemPrompt = (await getPromptContent("beer_knowledge", fallbackPrompt))
    .replace("{profileSummary}", profileSummary || "暂无品饮记录");

  const analysisCfg = await getModelConfig("analysis");
  const model = analysisCfg.model;

  try {
    const raw = await openrouterFetch({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `对话记录:\n${history}\n\n用户最新消息: ${lastUserText}` },
      ],
      temperature: analysisCfg.temperature,
      max_tokens: analysisCfg.maxTokens,
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
      reply: fallbackKnowledgeReply(lastUserText),
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }
}
