import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

// ── 查库预检:从用户消息里抽候选词,去本地酒库找事实 ──

const PROBE_STOP = new Set([
  "the", "a", "an", "what", "is", "are", "was", "of", "beer", "beers", "ipa",
  "lager", "stout", "ale", "pilsner", "please", "me", "my", "about", "which",
  "best", "good", "bad", "how", "does", "do", "with", "for", "and", "or",
  "this", "that", "it", "to", "in", "on", "whats", "sapporo", "brewery",
]);

function extractProbes(text: string): string[] {
  const probes: string[] = [];
  // 中文连续片段 2-8 字(酒名/酒厂中文名)
  for (const m of text.matchAll(/[一-鿿]{2,8}/g)) probes.push(m[0]);
  // 英文单词序列 1-3 词(跳过停用词)
  for (const m of text.matchAll(/[A-Za-z][A-Za-z'.\-]*(?:\s+[A-Za-z][A-Za-z'.\-]*){0,2}/g)) {
    const p = m[0].trim();
    if (p.length < 4 || PROBE_STOP.has(p.toLowerCase())) continue;
    probes.push(p);
  }
  return [...new Set(probes)].slice(0, 8);
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

  // 查库预检:从消息抽候选词,命中本地酒库(含中文别名桥)则把事实注入提示词
  let dbFacts = "";
  try {
    const probes = extractProbes(ctx.lastUserText);
    if (probes.length > 0) {
      const { lookupBeers } = await import("@/lib/beer-agent/beer-db");
      const lookups = await lookupBeers(probes);
      const hits = lookups.filter((r) => r.found && r.data);
      if (hits.length > 0) {
        dbFacts = hits.slice(0, 4).map((r) => {
          const d = r.data!;
          return `- ${d.name}（${d.brewery}）· ${d.style || "风格未知"} · ABV ${d.abv ?? "?"}% · 评分 ${d.rating ?? "?"}（${d.ratings_count ?? "?"} 人评）`;
        }).join("\n");
      }
    }
  } catch (err) {
    console.warn("[beer-knowledge] db probe failed:", err);
  }

  const systemPrompt = `你是 Beer Lens，一个懂啤酒的 AI 助手。

## 你的能力
- 回答啤酒知识问题（风格、酒厂、酿造工艺）
- 分析用户口味偏好
- 讨论啤酒文化和品饮技巧

## 用户画像
${profileSummary || "暂无品饮记录"}

${dbFacts ? `## 数据库事实（优先引用）
${dbFacts}

以上是本地酒库（Untappd/BeerAdvocate 数据）查到的真实记录。若与用户问题相关，请优先引用这些事实作答；不要说出与事实矛盾的评分、风格或酒厂信息。` : ""}

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
