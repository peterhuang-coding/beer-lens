import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import {
  appendTastingEpisode,
  type TastingEpisode,
} from "@/lib/beer-agent/memory/episodic";
import { rebuildProfileMemory, rebuildTrends } from "@/lib/beer-agent/memory/profile";
import { isMemoryWriteEnabled } from "@/lib/beer-agent/memory/memory-experiment";
import { readShortTermMemory } from "@/lib/beer-agent/memory/short-term";
import { recordTastingEpisode } from "@/lib/beer-agent/monitor/metrics";

// ── Feedback keyword lists ──

const AROMA_KEYWORDS = [
  "柑橘",
  "热带水果",
  "松针",
  "花香",
  "咖啡",
  "焦糖",
  "酸",
  "野菌",
  "酒精",
];

const TASTE_KEYWORDS = [
  "清爽",
  "顺滑",
  "多汁",
  "甜",
  "苦",
  "厚",
  "平衡",
  "干",
];

const CONTEXT_KEYWORDS = [
  "第一杯",
  "配餐",
  "慢慢喝",
  "尝新",
  "聚会",
  "收尾",
];

/**
 * Parse a score from user text.
 * Matches patterns like "4.5分", "4/5", "3分", "5/5".
 */
function parseScore(text: string): number | undefined {
  const match = text.match(/([1-5](?:\.\d+)?)\s*(?:分|\/5)/);
  if (match) {
    return parseFloat(match[1]);
  }
  return undefined;
}

/**
 * Parse would-drink-again from user text.
 * Negation MUST be checked BEFORE affirmation, otherwise "不会再喝" gets caught by "会再喝".
 * "不会再喝" / "不想再喝" → "no"
 * "会再喝" / "还会点" / "再喝" → "yes"
 * otherwise → "maybe"
 */
function parseWouldDrinkAgain(
  text: string,
): "yes" | "maybe" | "no" {
  // Check negation FIRST — must come before positive check
  if (/不会再喝|不想再喝|不会点/.test(text)) return "no";
  if (/会再喝|还会点|再喝/.test(text)) return "yes";
  return "maybe";
}

/**
 * Check if user text contains a specific beer name from candidates.
 */
function hasBeerNameInText(
  text: string,
  candidates: Array<{ displayName: string }>,
): boolean {
  return candidates.some(c =>
    c.displayName && c.displayName.length >= 2 && text.includes(c.displayName),
  );
}

/**
 * Extract matching tags from user text against a keyword list.
 */
function extractTags(text: string, keywords: string[]): string[] {
  return keywords.filter((kw) => text.includes(kw));
}

/** Convert a short-term memory candidate to the activeBeer format */
function setActiveBeer(c: {
  displayName: string;
  brewery?: string;
  style?: string;
  abv?: number;
  rating?: number | null;
}): {
  displayName: string;
  brewery?: string;
  style?: string;
  abv?: number;
  untappdScore?: number | null;
} {
  return {
    displayName: c.displayName,
    brewery: c.brewery,
    style: c.style,
    abv: c.abv,
    untappdScore: c.rating ?? null,
  };
}

export async function handleTastingFeedback(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  const userId = request.userId;
  const lastUserText = request.messages.at(-1)?.content ?? "";

  // ── 1. Parse feedback from last user message ──
  const overallScore = parseScore(lastUserText);
  const wouldDrinkAgain = parseWouldDrinkAgain(lastUserText);
  const aromaTags = extractTags(lastUserText, AROMA_KEYWORDS);
  const tasteTags = extractTags(lastUserText, TASTE_KEYWORDS);
  const contextTags = extractTags(lastUserText, CONTEXT_KEYWORDS);

  // ── 2. Try to match with active beer from short-term memory ──
  // Priority: explicit beer name in text > menuIndex ("第3个"/"3号") > topPick from lastMenu > unknown
  let activeBeer: {
    displayName: string;
    brewery?: string;
    style?: string;
    abv?: number;
    untappdScore?: number | null;
  } = { displayName: "未知啤酒" };

  let matchMethod: "exact_name" | "menu_index" | "top_pick" | "unknown" = "unknown";

  try {
    const stm = await readShortTermMemory(request.conversationId);
    const candidates = stm?.lastMenu?.candidates ?? [];
    const lastPicks = stm?.lastPicks;

    // Priority 1: explicit beer name in user text → fuzzy match against candidates
    for (const c of candidates) {
      const displayName = c.displayName.trim();
      if (!displayName || displayName.length < 2) continue;

      // Exact match: user text contains the full candidate name
      if (lastUserText.toLowerCase().includes(displayName.toLowerCase())) {
        activeBeer = setActiveBeer(c);
        matchMethod = "exact_name";
        break;
      }

      // Fuzzy match: candidate name contains user text (e.g., "Green City" in "Green City IPA")
      if (displayName.toLowerCase().includes(lastUserText.toLowerCase()) && lastUserText.length >= 2) {
        activeBeer = setActiveBeer(c);
        matchMethod = "exact_name";
        break;
      }

      // Partial match: split candidate name into words, check if user text contains significant words
      const nameWords = displayName.split(/[\s·\-]+/).filter(w => w.length >= 2);
      if (nameWords.length > 0 && nameWords.some(w => lastUserText.includes(w))) {
        activeBeer = setActiveBeer(c);
        matchMethod = "exact_name";
        break;
      }
    }

    // Priority 2: menuIndex reference — supports Arabic digits AND Chinese ordinals
    if (matchMethod === "unknown") {
      // Arabic: "第3个", "3号", "第3杯", "第3款"
      let indexMatch = lastUserText.match(/第\s*(\d+)\s*(?:个|号|杯|款)/);
      if (!indexMatch) {
        // Chinese ordinals: "第三杯", "第三款", "第三个"
        const chineseOrdinals: Record<string, number> = {
          "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
          "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
        };
        const chMatch = lastUserText.match(/第\s*([一二三四五六七八九十])\s*(?:个|号|杯|款)/);
        if (chMatch) {
          const num = chineseOrdinals[chMatch[1]];
          if (num) {
            // Convert to a result that our existing logic can use
            const idx = num - 1;
            if (idx >= 0 && idx < candidates.length) {
              const c = candidates[idx];
              activeBeer = {
                displayName: c.displayName,
                brewery: c.brewery,
                style: c.style,
                abv: c.abv,
                untappdScore: c.rating ?? null,
              };
              matchMethod = "menu_index";
            }
          }
        }
      }
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10) - 1;
        if (idx >= 0 && idx < candidates.length) {
          const c = candidates[idx];
          activeBeer = {
            displayName: c.displayName,
            brewery: c.brewery,
            style: c.style,
            abv: c.abv,
            untappdScore: c.rating ?? null,
          };
          matchMethod = "menu_index";
        }
      }
    }

    // Priority 3: fall back to topPick only if no other match
    if (matchMethod === "unknown" && lastPicks?.topPick?.candidateId) {
      const topCandidate = candidates.find(
        c => c.candidateId === lastPicks.topPick!.candidateId,
      );
      if (topCandidate) {
        activeBeer = {
          displayName: topCandidate.displayName,
          brewery: topCandidate.brewery,
          style: topCandidate.style,
          abv: topCandidate.abv,
          untappdScore: topCandidate.rating ?? null,
        };
        matchMethod = "top_pick";
      }
    }

    // Priority 4: if we have candidates but no match, AND user gave a score
    // → don't guess, ask which beer (PREVENTS profile pollution)
    if (matchMethod === "unknown" && candidates.length > 0 && overallScore != null) {
      return {
        mode: "recommend",
        reply: '你说的是哪一款酒？可以告诉我序号（比如"第3个"）或者酒名，我帮你记录。',
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
      };
    }
  } catch {
    // No short-term memory — proceed without beer details
  }

  // ── 3. Build the TastingEpisode ──
  const episode: TastingEpisode = {
    id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    createdAt: new Date().toISOString(),
    sourceTraceId: context.traceId,
    beer: activeBeer,
    feedback: {
      overallScore,
      wouldDrinkAgain,
      aromaTags,
      tasteTags,
      contextTags,
      note: lastUserText,
    },
    context: request.metadata?.venue
      ? { venue: request.metadata.venue }
      : undefined,
  };

  // ── 4. Persist episode and rebuild profile (gated by memory experiment)
  const memoryWriteEnabled = await isMemoryWriteEnabled(userId);
  let profile;
  if (memoryWriteEnabled) {
    await appendTastingEpisode(userId, episode);
    recordTastingEpisode();
    profile = await rebuildProfileMemory(userId);

    // Fire-and-forget: rebuild trends in background (non-blocking for fast response)
    rebuildTrends(userId).catch((err) =>
      console.warn("[tasting-feedback] trends rebuild failed:", err),
    );
  } else {
    // AB off: still persist the raw episode + record the metric so user feedback
    // isn't lost — only the expensive O(N) aggregation (profile rebuild + trends)
    // is skipped. UI will surface "完整画像重建待恢复" instead of a hard-off stub.
    try {
      await appendTastingEpisode(userId, episode);
      recordTastingEpisode();
    } catch (err) {
      console.warn("[tasting-feedback] episode append failed in AB off branch:", err);
    }

    profile = {
      userId,
      updatedAt: new Date().toISOString(),
      summary: "完整画像重建待恢复（已保存原始 episode）。",
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

  // ── 5. Return confirmation response ──
  const scoreLine =
    overallScore != null
      ? `评分：${overallScore}/5`
      : "评分：未提供";

  const wouldAgainLine =
    wouldDrinkAgain === "yes"
      ? "你会再喝这杯酒。"
      : wouldDrinkAgain === "no"
        ? "你不会再喝这杯酒。"
        : "是否再喝：未明确。";

  const memoryNote = memoryWriteEnabled
    ? ""
    : "\n（本次反馈已写入 episode 记录，完整画像重建待恢复）";

  return {
    mode: "recommend",
    reply: [
      `收到！已记录你对「${activeBeer.displayName}」的品饮反馈。`,
      scoreLine,
      wouldAgainLine,
      profile.notes.length > 0 ? `备注：${episode.feedback.note}` : "",
      memoryNote,
      "",
      `你的口味画像：${profile.summary}`,
    ]
      .filter(Boolean)
      .join("\n"),
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
  };
}
