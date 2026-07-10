import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse, BeerCandidate, Pick } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { lookupBeers, enrichCandidates } from "@/lib/beer-agent/beer-db/pipeline";
import type { BeerLookupResult, EnrichInput } from "@/lib/beer-agent/beer-db/pipeline";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";
import { readShortTermMemory } from "@/lib/beer-agent/memory/short-term";
import { scoreCandidates } from "@/lib/beer-agent/recommendation/scoring";
import { selectPicks } from "@/lib/beer-agent/recommendation/pick-selector";
import { buildRecommendationReply } from "@/lib/beer-agent/recommendation/reply-builder";
import type { ScoredCandidate } from "@/lib/beer-agent/recommendation/types";

// ── Text extraction ──

/**
 * Check if the user text looks like a generic recommendation request
 * rather than listing specific beer names.
 */
function isGenericRecommendRequest(text: string): boolean {
  const genericPatterns = [
    /^推荐.*IPA$/,
    /^推荐.*拉格$/,
    /^推荐.*世涛$/,
    /^推荐.*皮尔森$/,
    /^推荐.*小麦$/,
    /^推荐.*酸$/,
    /^推荐.*sour/i,
    /^推荐.*stout/i,
    /^推荐.*清爽/,
    /^推荐.*不苦/,
    /^推荐一款/,
    /^推荐一下/,
    /^帮我推荐/,
    /^帮我.*选/,
    /^帮我.*挑/,
    /^今天喝什么/,
    /^喝什么.*好/,
    /^想喝.*清爽/,
    /^想喝点/,
    /^有什么.*推荐/,
    /^帮我看看.*酒单/,
    /^给我推荐/,
  ];
  return genericPatterns.some(p => p.test(text));
}

/**
 * Extract raw beer-name-like segments from the last user message.
 * Splits on newlines, Chinese/English commas, and other common delimiters.
 */
function extractBeerSegments(text: string): string[] {
  const parts = text.split(/[\n\r,，、;；。\t]+/);
  return parts
    .map((p) => p.trim())
    .filter((p) => {
      if (!p || p.length < 2) return false;
      const stopWords = [
        "推荐", "帮我看", "看看", "帮我", "建议", "好喝", "什么",
        "怎么", "如何", "这个", "那个", "哪个", "推荐一",
        "第", "杯", "预算", "配餐", "清爽", "不苦",
      ];
      for (const sw of stopWords) {
        if (p.length <= 6 && p.includes(sw)) return false;
      }
      return true;
    });
}

// ── Candidate construction ──

/**
 * Resolve a set of query strings into ScoredCandidate[] by:
 *   1. Calling batchLookupBeers on all queries
 *   2. Merging results with the original query names
 */
async function resolveBeerCandidates(queries: string[]): Promise<ScoredCandidate[]> {
  if (queries.length === 0) return [];

  const results = await lookupBeers(queries);

  return queries.map((raw, i) => {
    const result: BeerLookupResult | undefined = results[i];
    const data = result?.data;
    const found = result?.found === true && data != null;

    return {
      candidateId: String(i + 1),
      menuIndex: i + 1,
      displayName: found ? data!.name : raw,
      brewery: found ? data!.brewery : "",
      style: found ? data!.style : "",
      abv: found && data!.abv != null ? data!.abv : 0,
      price: null,
      volumeMl: null,
      worthScore: 0,
      fitScore: 0,
      riskFlags: [],
      reason: "",
      rating: found && data!.rating > 0 ? data!.rating : null,
      ratingsCount: found && data!.ratings_count != null ? data!.ratings_count : null,
      source: found ? data!.source : undefined,
    };
  });
}

// ── Conversion to AgentResponse types ──

function scoredToBeerCandidate(scored: ScoredCandidate): BeerCandidate {
  return {
    candidateId: scored.candidateId,
    menuIndex: scored.menuIndex,
    displayName: scored.displayName,
    brewery: scored.brewery,
    style: scored.style,
    abv: scored.abv,
    ibu: null,
    hops: [],
    worthScore: scored.worthScore,
    fitScore: scored.fitScore,
    riskFlags: scored.riskFlags,
    reason: scored.reason,
    evidence: [],
    price: scored.price,
    volumeMl: scored.volumeMl,
    untappdScore: scored.rating,
    untappdRatingCount: scored.ratingsCount,
  };
}

function pickToPick(p: {
  candidateId: string;
  label: string;
  reason: string;
  worthScore: number;
  fitScore: number;
}): Pick {
  return {
    candidateId: p.candidateId,
    label: p.label,
    reason: p.reason,
    worthScore: p.worthScore,
    fitScore: p.fitScore,
  };
}

// ── Image pipeline integration ──
// Bridges the vision pipeline (OCR + enrichment) output into ScoredCandidate[]
// for the new recommendation engine.

async function runImagePipelineAndScore(
  request: BeerDialogRequest,
): Promise<{ candidates: BeerCandidate[]; picks: AgentResponse["picks"]; reply: string; stages?: Record<string, unknown> }> {
  // Dynamic import to avoid circular dependency
  const { runImagePipeline } = await import("@/lib/beer-agent/provider");
  const { getProfileSummary } = await import("@/lib/beer-agent/profile");

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("请在 .env.local 中配置 OPENROUTER_API_KEY");
  }

  const imageDataUrl = request.image!.dataUrl!;
  const userText = request.messages.at(-1)?.content ?? "帮我看这张酒单并推荐";
  const profileSummary = await getProfileSummary();

  // Run the vision pipeline: classify + OCR + visual quality + enrich
  const pipelineResult = await runImagePipeline(
    apiKey,
    imageDataUrl,
    userText,
    profileSummary,
    undefined, // no progress callback for now
  );

  // Convert the pipeline's BeerCandidates to ScoredCandidates
  const scoredCandidates: ScoredCandidate[] = pipelineResult.candidates.map((c) => ({
    candidateId: c.candidateId,
    menuIndex: c.menuIndex,
    displayName: c.displayName,
    brewery: c.brewery,
    style: c.style,
    abv: c.abv,
    price: c.price ?? null,
    volumeMl: c.volumeMl ?? null,
    worthScore: 0,
    fitScore: 0,
    riskFlags: c.riskFlags,
    reason: "",
    rating: c.untappdScore ?? null,
    ratingsCount: c.untappdRatingCount ?? null,
    source: c.untappdId ? "untappd" : "ocr",
  }));

  // Score candidates using the new recommendation engine
  const profile = await getProfileMemory(request.userId).catch(() => null);
  const stm = await readShortTermMemory(request.conversationId).catch(() => null);
  const constraints = stm?.currentConstraints ?? [];
  const scored = scoreCandidates(scoredCandidates, profile, constraints);
  const picks = selectPicks(scored);
  const reply = buildRecommendationReply(picks, scored);
  const candidates = scored.map(scoredToBeerCandidate);

  return {
    candidates,
    picks: {
      topPick: pickToPick(picks.topPick),
      safePick: pickToPick(picks.safePick),
      explorePick: pickToPick(picks.explorePick),
      avoidOrCaution: pickToPick(picks.avoidOrCaution),
    },
    reply,
    stages: pipelineResult.stages,
  };
}

// ── Handler ──

/**
 * Check if the user text looks like a follow-up constraint
 * (e.g., "有IPA吗", "不苦的", "第3个怎么样") rather than a fresh request.
 * Only applies when there's an active menu context.
 */
function looksLikeFollowUp(text: string): boolean {
  const followUpPatterns = [
    /^有.*吗$/,
    /^有没有/,
    /第\d+个/,
    /第\d+号/,
    /第\d+款/,
    /第\d+杯/,
    /哪个.*便宜/,
    /哪个.*好/,
    /怎么.*样/,
    /不苦/,
    /不要太苦/,
    /清爽的/,
    /烈的/,
    /淡的/,
    /IPA/,
    /ipa/,
    /拉格/,
    /世涛/,
    /皮尔森/,
    /小麦/,
    /酸的/,
    /便宜的/,
    /贵的/,
    /多少钱/,
    /介绍.*第/,
    /说说.*第/,
    /尝新/,
    /特别/,
    /预算/,
  ];
  return followUpPatterns.some(p => p.test(text));
}

/** Extract style/constraint keywords from follow-up text */
function extractConstraints(text: string): string[] {
  const c: string[] = [];
  if (/IPA|ipa/i.test(text)) c.push("IPA");
  if (/拉格|lager|皮尔森|pils/i.test(text)) c.push("lager");
  if (/世涛|stout/i.test(text)) c.push("stout");
  if (/酸|sour|gose|柏林/i.test(text)) c.push("sour");
  if (/小麦|wheat|hefe|白啤/i.test(text)) c.push("wheat");
  if (/清爽|不苦|淡|light/i.test(text)) c.push("crisp");
  if (/烈|浓|重|imperial|double/i.test(text)) c.push("strong");
  if (/尝新|特别|奇怪|怪/i.test(text)) c.push("explore");
  if (/第一杯|开场/i.test(text)) c.push("first_beer");
  if (/配餐|下饭|吃饭/i.test(text)) c.push("with_food");
  if (/便宜|预算|省钱/i.test(text)) c.push("budget");
  return c;
}

function matchConstraint(c: ScoredCandidate, constraint: string): boolean {
  const style = (c.style || "").toLowerCase();
  const name = (c.displayName || "").toLowerCase();
  const s = `${style} ${name}`;
  const map: Record<string, RegExp> = {
    IPA: /ipa|pale ale/i,
    lager: /lager|pils|拉格|皮尔森/i,
    stout: /stout|世涛/i,
    sour: /sour|gose|酸|berliner|野菌|lambic|flemish/i,
    wheat: /wheat|hefe|wit|白啤|小麦/i,
    crisp: /pils|lager|pale|session|kolsch|拉格|皮尔森|清爽/i,
    strong: /imperial|double|triple|barrel|barley|帝国/i,
  };
  const re = map[constraint];
  if (re) return re.test(s);
  return true;
}

/**
 * Follow-up filter path: filter/extend the existing menu candidates based on user constraints.
 */
async function handleFollowUp(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  const stm = await readShortTermMemory(request.conversationId).catch(() => null);
  const menuCandidates = stm?.lastMenu?.candidates ?? [];

  if (menuCandidates.length === 0) {
    return {
      mode: "recommend",
      reply: "我现在没有上一张酒单上下文，你发一下酒单或告诉我酒名，我再帮你筛。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: context.memorySnapshot?.profileSummary ?? "",
    };
  }

  const userText = request.messages.at(-1)?.content ?? "";
  const profile = await getProfileMemory(request.userId).catch(() => null);

  // Convert menu candidates to ScoredCandidate[]
  const scored: ScoredCandidate[] = menuCandidates.map((c, i) => ({
    candidateId: c.candidateId || String(i + 1),
    menuIndex: i + 1,
    displayName: c.displayName,
    brewery: c.brewery || "",
    style: c.style || "",
    abv: c.abv || 0,
    price: c.price ?? null,
    volumeMl: null,
    worthScore: 0,
    fitScore: 0,
    riskFlags: [],
    reason: "",
    rating: c.rating ?? null,
    ratingsCount: null,
    source: "short_term",
  }));

  const constraints = extractConstraints(userText);

  let filtered = scored;
  if (constraints.length > 0) {
    filtered = scored.filter(c =>
      constraints.every(ct => matchConstraint(c, ct))
    );
  }

  if (filtered.length === 0) {
    const names = scored.map(c => c.displayName).join("、");
    return {
      mode: "recommend",
      reply: `酒单上没有符合「${constraints.join("、")}」的酒。现有：${names}。要不要换个方向？`,
      candidates: scored.map(scoredToBeerCandidate),
      picks: emptyPicks(),
      profileSummary: profile?.summary ?? "",
    };
  }

  const scored2 = scoreCandidates(filtered, profile, constraints);
  const picks = selectPicks(scored2);
  const reply = buildRecommendationReply(picks, scored2);
  const candidates = scored2.map(scoredToBeerCandidate);

  return {
    mode: "recommend",
    reply,
    candidates,
    picks: {
      topPick: pickToPick(picks.topPick),
      safePick: pickToPick(picks.safePick),
      explorePick: pickToPick(picks.explorePick),
      avoidOrCaution: pickToPick(picks.avoidOrCaution),
    },
    profileSummary: profile?.summary ?? "",
  };
}

export async function handleMenuRecommend(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  const lastUserText = request.messages.at(-1)?.content ?? "";

  // ── Follow-up path: active menu context + constraint-like text → filter mode ──
  if (!request.image?.dataUrl) {
    const stm = await readShortTermMemory(request.conversationId).catch(() => null);
    const hasActiveMenu = (stm?.lastMenu?.candidates?.length ?? 0) > 0;
    if (hasActiveMenu && looksLikeFollowUp(lastUserText)) {
      return handleFollowUp(request, context);
    }
  }

  // ── Image mode ──
  if (request.image?.dataUrl) {
    try {
      const result = await runImagePipelineAndScore(request);
      return {
        mode: "recommend",
        reply: result.reply,
        candidates: result.candidates,
        picks: result.picks,
        profileSummary: context.memorySnapshot?.profileSummary ?? "",
        stages: result.stages,
      };
    } catch (err) {
      console.warn("[menu-recommend] image pipeline error:", err);
      return {
        mode: "recommend",
        reply: "抱歉，分析这张图片时出错了。请再试一次或直接告诉我酒名。",
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
      };
    }
  }

  // ── Text-only mode ──
  try {
    if (isGenericRecommendRequest(lastUserText)) {
      return {
        mode: "recommend",
        reply: "我可以帮你根据口味推荐啤酒！请先发一张酒单照片（图片清晰最准），或者直接告诉我具体酒名，我帮你对比评分和口感。你想喝什么风格？IPA？拉格？世涛？",
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
      };
    }

    const candidateQueries = extractBeerSegments(lastUserText);

    if (candidateQueries.length === 0 && lastUserText.trim().length >= 2) {
      candidateQueries.push(lastUserText.trim());
    }

    if (candidateQueries.length === 0) {
      return {
        mode: "recommend",
        reply: "请发一张酒单照片，或者直接告诉我酒名，我帮你推荐。",
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
      };
    }

    const scoredCandidates = await resolveBeerCandidates(candidateQueries);
    const profile = await getProfileMemory(request.userId).catch(() => null);
    const stm = await readShortTermMemory(request.conversationId).catch(() => null);
    const constraints = stm?.currentConstraints ?? [];
    const scored = scoreCandidates(scoredCandidates, profile, constraints);
    const picks = selectPicks(scored);
    const reply = buildRecommendationReply(picks, scored);
    const candidates = scored.map(scoredToBeerCandidate);
    const profileSummary = profile?.summary ?? "";

    return {
      mode: "recommend",
      reply,
      candidates,
      picks: {
        topPick: pickToPick(picks.topPick),
        safePick: pickToPick(picks.safePick),
        explorePick: pickToPick(picks.explorePick),
        avoidOrCaution: pickToPick(picks.avoidOrCaution),
      },
      profileSummary,
    };
  } catch (err) {
    console.warn("[menu-recommend] handler error:", err);
    return {
      mode: "recommend",
      reply: "抱歉，处理推荐请求时出错了。请再试一次。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }
}
