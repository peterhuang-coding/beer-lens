import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

const AROMA_KEYWORDS = ["柑橘", "热带水果", "松针", "花香", "咖啡", "焦糖", "酸", "野菌", "酒精"];
const TASTE_KEYWORDS = ["清爽", "顺滑", "多汁", "甜", "苦", "厚", "平衡", "干"];
const CONTEXT_KEYWORDS = ["第一杯", "配餐", "慢慢喝", "尝新", "聚会", "收尾"];

function parseScore(text: string): number | undefined {
  const match = text.match(/([1-5](?:\.\d+)?)\s*(?:分|\/5)/);
  return match ? parseFloat(match[1]) : undefined;
}

function parseWouldDrinkAgain(text: string): "yes" | "maybe" | "no" {
  if (/不会再喝|不想再喝|不会点/.test(text)) return "no";
  if (/会再喝|还会点|再喝/.test(text)) return "yes";
  return "maybe";
}

function extractTags(text: string, keywords: string[]): string[] {
  return keywords.filter((kw) => text.includes(kw));
}

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  const lastUserText = ctx.lastUserText;

  const overallScore = parseScore(lastUserText);
  const wouldDrinkAgain = parseWouldDrinkAgain(lastUserText);
  const aromaTags = extractTags(lastUserText, AROMA_KEYWORDS);
  const tasteTags = extractTags(lastUserText, TASTE_KEYWORDS);
  const contextTags = extractTags(lastUserText, CONTEXT_KEYWORDS);

  // Match with active beer from short-term memory
  let activeBeer: {
    displayName: string;
    brewery?: string;
    style?: string;
    abv?: number;
    untappdScore?: number | null;
  } = { displayName: "未知啤酒" };

  let matchMethod: string = "unknown";

  try {
    const { readShortTermMemory } = await import("@/lib/beer-agent/memory/short-term");
    const stm = await readShortTermMemory(ctx.conversationId, ctx.userId);
    const candidates = stm?.lastMenu?.candidates ?? [];
    const lastPicks = stm?.lastPicks;

    // Priority 1: beer name in text
    for (const c of candidates) {
      const name = c.displayName.trim();
      if (!name || name.length < 2) continue;
      if (lastUserText.toLowerCase().includes(name.toLowerCase())) {
        activeBeer = { displayName: c.displayName, brewery: c.brewery, style: c.style, abv: c.abv, untappdScore: c.rating ?? null };
        matchMethod = "exact_name";
        break;
      }
      if (name.toLowerCase().includes(lastUserText.toLowerCase()) && lastUserText.length >= 2) {
        activeBeer = { displayName: c.displayName, brewery: c.brewery, style: c.style, abv: c.abv, untappdScore: c.rating ?? null };
        matchMethod = "exact_name";
        break;
      }
    }

    // Priority 2: menu index
    if (matchMethod === "unknown") {
      let indexMatch = lastUserText.match(/第\s*(\d+)\s*(?:个|号|杯|款)/);
      if (!indexMatch) {
        const chineseOrdinals: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
        const chMatch = lastUserText.match(/第\s*([一二三四五六七八九十])\s*(?:个|号|杯|款)/);
        if (chMatch && chineseOrdinals[chMatch[1]]) {
          const idx = chineseOrdinals[chMatch[1]] - 1;
          if (idx >= 0 && idx < candidates.length) {
            const c = candidates[idx];
            activeBeer = { displayName: c.displayName, brewery: c.brewery, style: c.style, abv: c.abv, untappdScore: c.rating ?? null };
            matchMethod = "menu_index";
          }
        }
      } else {
        const idx = parseInt(indexMatch[1], 10) - 1;
        if (idx >= 0 && idx < candidates.length) {
          const c = candidates[idx];
          activeBeer = { displayName: c.displayName, brewery: c.brewery, style: c.style, abv: c.abv, untappdScore: c.rating ?? null };
          matchMethod = "menu_index";
        }
      }
    }

    // Priority 3: topPick
    if (matchMethod === "unknown" && lastPicks?.topPick?.candidateId) {
      const topCandidate = candidates.find((c) => c.candidateId === lastPicks.topPick!.candidateId);
      if (topCandidate) {
        activeBeer = { displayName: topCandidate.displayName, brewery: topCandidate.brewery, style: topCandidate.style, abv: topCandidate.abv, untappdScore: topCandidate.rating ?? null };
        matchMethod = "top_pick";
      }
    }

    // If no match but score present → ask
    if (matchMethod === "unknown" && candidates.length > 0 && overallScore != null) {
      return {
        skillId: "taste-feedback",
        reply: '你说的是哪一款酒？可以告诉我序号（比如"第3个"）或者酒名，我帮你记录。',
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
        errors: [],
      };
    }
  } catch { /* no STM — proceed */ }

  // Build tasting episode
  const { appendTastingEpisode } = await import("@/lib/beer-agent/memory/episodic");
  const { rebuildProfileMemory, rebuildTrends } = await import("@/lib/beer-agent/memory/profile");
  const { isMemoryWriteEnabled } = await import("@/lib/beer-agent/memory/memory-experiment");

  const episode = {
    id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: ctx.userId,
    createdAt: new Date().toISOString(),
    sourceTraceId: ctx.traceId,
    beer: activeBeer,
    feedback: {
      overallScore,
      wouldDrinkAgain,
      aromaTags,
      tasteTags,
      contextTags,
      note: lastUserText,
    },
  };

  const memoryWriteEnabled = await isMemoryWriteEnabled(ctx.userId);
  let profile;

  if (memoryWriteEnabled) {
    await appendTastingEpisode(ctx.userId, episode);
    profile = await rebuildProfileMemory(ctx.userId);
    rebuildTrends(ctx.userId).catch(() => {});
  } else {
    profile = {
      userId: ctx.userId,
      updatedAt: new Date().toISOString(),
      summary: "记忆写入已关闭，未生成口味画像。",
      preferredStyles: [],
      dislikedStyles: [],
      preferredTags: [],
      dislikedTags: [],
      notes: [],
      confidence: 0,
      evidenceCount: 0,
      correctionsCount: 0,
      correctionsApplied: false,
    };
  }

  const scoreLine = overallScore != null ? `评分：${overallScore}/5` : "评分：未提供";
  const wouldAgainLine = wouldDrinkAgain === "yes" ? "你会再喝这杯酒。" : wouldDrinkAgain === "no" ? "你不会再喝这杯酒。" : "是否再喝：未明确。";
  const memoryNote = memoryWriteEnabled ? "" : "\n（记忆写入已关闭，本次反馈未保存到长期记忆）";

  return {
    skillId: "taste-feedback",
    reply: [
      `收到！已记录你对「${activeBeer.displayName}」的品饮反馈。`,
      scoreLine,
      wouldAgainLine,
      profile.notes?.length > 0 ? `备注：${episode.feedback.note}` : "",
      memoryNote,
      "",
      `你的口味画像：${profile.summary}`,
    ].filter(Boolean).join("\n"),
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
    errors: [],
  };
}
