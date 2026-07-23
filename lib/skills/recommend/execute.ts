/**
 * Recommend Skill — execution logic.
 *
 * Three paths:
 *   1. Image mode → vision pipeline (OCR + enrich + score + picks)
 *   2. Follow-up mode → filter existing menu candidates by constraints
 *   3. Text-only mode → extract beer queries → lookup → score → picks
 */

import type { AgentContext, SkillResult } from "@/lib/agent/types";
import type { ScoredCandidate } from "@/lib/beer-agent/recommendation/types";
import type { BeerCandidate } from "@/lib/beer-agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

// ── Image pipeline path ──
async function handleImage(ctx: AgentContext): Promise<SkillResult> {
  if (!ctx.imageDataUrl) {
    return {
      skillId: "recommend",
      reply: "请发一张酒单照片给我，我帮你选。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: ctx.profileSummary ?? "",
      errors: [],
    };
  }

  try {
    const { runImagePipeline } = await import("@/lib/beer-agent/provider");
    const { getProfileSummary } = await import("@/lib/beer-agent/profile");
    const { scoreCandidates } = await import("@/lib/beer-agent/recommendation/scoring");
    const { selectPicks } = await import("@/lib/beer-agent/recommendation/pick-selector");
    const { buildRecommendationReply } = await import("@/lib/beer-agent/recommendation/reply-builder");
    const { getProfileMemory } = await import("@/lib/beer-agent/memory/profile");
    const { isMemoryReadEnabled } = await import("@/lib/beer-agent/memory/memory-experiment");
    const { readShortTermMemory } = await import("@/lib/beer-agent/memory/short-term");

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

    const profileSummary = await getProfileSummary();
    const pipelineResult = await runImagePipeline(
      apiKey,
      ctx.imageDataUrl,
      ctx.lastUserText,
      profileSummary,
    );

    // Convert pipeline candidates to scored format
    const scoredInput = pipelineResult.candidates.map((c) => ({
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
      source: c.untappdId ? "untappd" : "ocr" as string,
    }));

    // Profile and scoring
    const memoryEnabled = await isMemoryReadEnabled(ctx.userId).catch(() => false);
    let profile = null;
    if (memoryEnabled) {
      profile = await getProfileMemory(ctx.userId).catch(() => null);
    }
    const stm = await readShortTermMemory(ctx.conversationId).catch(() => null);
    const constraints = stm?.currentConstraints ?? [];
    const scored = scoreCandidates(scoredInput as any, profile, constraints, memoryEnabled);
    const picks = selectPicks(scored as any);
    const reply = buildRecommendationReply(picks, scored as any);

    return {
      skillId: "recommend",
      reply,
      candidates: scored.map(scoredToCandidate),
      picks: {
        topPick: { ...picks.topPick },
        safePick: { ...picks.safePick },
        explorePick: { ...picks.explorePick },
        avoidOrCaution: { ...picks.avoidOrCaution },
      },
      profileSummary: profile?.summary ?? "",
      data: { imagePipeline: true, candidateCount: scored.length },
      errors: [],
    };
  } catch (err) {
    return {
      skillId: "recommend",
      reply: "抱歉，分析这张图片时出错了。请再试一次或直接告诉我酒名。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

// ── Follow-up path ──
async function handleFollowUp(ctx: AgentContext): Promise<SkillResult> {
  const { readShortTermMemory } = await import("@/lib/beer-agent/memory/short-term");
  const { getProfileMemory } = await import("@/lib/beer-agent/memory/profile");
  const { isMemoryReadEnabled } = await import("@/lib/beer-agent/memory/memory-experiment");
  const { scoreCandidates } = await import("@/lib/beer-agent/recommendation/scoring");
  const { selectPicks } = await import("@/lib/beer-agent/recommendation/pick-selector");
  const { buildRecommendationReply } = await import("@/lib/beer-agent/recommendation/reply-builder");

  const stm = await readShortTermMemory(ctx.conversationId).catch(() => null);
  const menuCandidates = stm?.lastMenu?.candidates ?? [];

  if (menuCandidates.length === 0) {
    return {
      skillId: "recommend",
      reply: "我现在没有上一张酒单上下文，你发一下酒单或告诉我酒名，我再帮你筛。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: ctx.profileSummary ?? "",
      errors: [],
    };
  }

  const constraints = extractConstraints(ctx.lastUserText);
  const scoredInput = menuCandidates.map((c, i) => ({
    candidateId: c.candidateId || String(i + 1),
    menuIndex: i + 1,
    displayName: c.displayName,
    brewery: c.brewery || "",
    style: c.style || "",
    abv: c.abv || 0,
    price: c.price ?? null,
    volumeMl: null as number | null,
    worthScore: 0,
    fitScore: 0,
    riskFlags: [] as string[],
    reason: "",
    rating: c.rating ?? null,
    ratingsCount: null as number | null,
    source: "short_term" as string,
  }));

  let filtered = scoredInput;
  if (constraints.length > 0) {
    filtered = scoredInput.filter((c) =>
      constraints.every((ct) => matchConstraint(c, ct)),
    );
  }

  if (filtered.length === 0) {
    const names = scoredInput.map((c) => c.displayName).join("、");
    return {
      skillId: "recommend",
      reply: `酒单上没有符合「${constraints.join("、")}」的酒。现有：${names}。要不要换个方向？`,
      candidates: scoredInput.map(scoredToCandidate),
      picks: emptyPicks(),
      profileSummary: ctx.profileSummary ?? "",
      errors: [],
    };
  }

  const memoryEnabled = await isMemoryReadEnabled(ctx.userId).catch(() => false);
  const profile = memoryEnabled ? await getProfileMemory(ctx.userId).catch(() => null) : null;
  const scored = scoreCandidates(filtered as any, profile, constraints, memoryEnabled);
  const picks = selectPicks(scored as any);
  const reply = buildRecommendationReply(picks, scored as any);

  return {
    skillId: "recommend",
    reply,
    candidates: scored.map(scoredToCandidate),
    picks: {
      topPick: { ...picks.topPick },
      safePick: { ...picks.safePick },
      explorePick: { ...picks.explorePick },
      avoidOrCaution: { ...picks.avoidOrCaution },
    },
    profileSummary: profile?.summary ?? "",
    errors: [],
  };
}

// ── Text-only path ──
async function handleText(ctx: AgentContext, params: Record<string, unknown>): Promise<SkillResult> {
  const { lookupBeers, enrichCandidates } = await import("@/lib/beer-agent/beer-db/pipeline");
  const { getProfileMemory } = await import("@/lib/beer-agent/memory/profile");
  const { isMemoryReadEnabled } = await import("@/lib/beer-agent/memory/memory-experiment");
  const { scoreCandidates } = await import("@/lib/beer-agent/recommendation/scoring");
  const { selectPicks } = await import("@/lib/beer-agent/recommendation/pick-selector");
  const { buildRecommendationReply } = await import("@/lib/beer-agent/recommendation/reply-builder");
  const { readShortTermMemory } = await import("@/lib/beer-agent/memory/short-term");

  const styleParam = params.style as string | undefined;
  const constraintsParam = params.constraints as string[] | undefined;

  // Determine queries from text
  const queries = styleParam
    ? [styleParam]
    : extractBeerSegments(ctx.lastUserText);

  // Generic recommendation fallback
  if (queries.length === 0 && ctx.lastUserText.trim().length >= 2) {
    const genericQueries = genericRecommendationQueries(ctx.lastUserText);
    if (genericQueries.length > 0) {
      queries.push(...genericQueries);
    } else {
      queries.push(ctx.lastUserText.trim());
    }
  }

  if (queries.length === 0) {
    return {
      skillId: "recommend",
      reply: "请发一张酒单照片，或者直接告诉我酒名，我帮你推荐。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [],
    };
  }

  // Lookup beers
  const results = await lookupBeers(queries);

  // Enrich missed queries
  const missedQueries: { idx: number; raw: string }[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (!results[i]?.found) missedQueries.push({ idx: i, raw: queries[i] });
  }
  if (missedQueries.length > 0) {
    try {
      const enriched = await enrichCandidates(missedQueries.map((q) => ({ beerName: q.raw })));
      for (let fi = 0; fi < missedQueries.length; fi++) {
        const { idx } = missedQueries[fi];
        const enrichedBeer = enriched[fi];
        if (enrichedBeer && enrichedBeer.source !== "none" && enrichedBeer.untappdScore != null) {
          results[idx] = {
            query: queries[idx],
            found: true,
            data: { id: enrichedBeer.untappdId ?? `enriched_${idx}`, name: enrichedBeer.beerName, brewery: enrichedBeer.breweryName, style: enrichedBeer.style, abv: enrichedBeer.abv, rating: enrichedBeer.untappdScore ?? 0, ratings_count: enrichedBeer.untappdRatingCount ?? 0, source: "untappd", found: true, confidence: "medium", untappd_url: enrichedBeer.untappdUrl ?? undefined, country: enrichedBeer.breweryCountry ?? undefined },
          };
        }
      }
    } catch { /* enricher failed silently */ }
  }

  // Convert to scored candidates
  const scoredInput = queries.map((raw, i) => {
    const result = results[i];
    const data = result?.data;
    const found = result?.found === true && data != null;
    return {
      candidateId: String(i + 1),
      menuIndex: i + 1,
      displayName: found ? data!.name : raw,
      brewery: found ? data!.brewery : "",
      style: found ? data!.style : "",
      abv: found && data!.abv != null ? data!.abv : 0,
      price: null as number | null,
      volumeMl: null as number | null,
      worthScore: 0,
      fitScore: 0,
      riskFlags: [] as string[],
      reason: "",
      rating: found && data!.rating > 0 ? data!.rating : null,
      ratingsCount: found && data!.ratings_count != null ? data!.ratings_count : null,
      source: found ? data!.source : undefined,
    };
  });

  // Score
  const memoryEnabled = await isMemoryReadEnabled(ctx.userId).catch(() => false);
  const profile = memoryEnabled ? await getProfileMemory(ctx.userId).catch(() => null) : null;
  const stm = await readShortTermMemory(ctx.conversationId).catch(() => null);
  const allConstraints = [...(constraintsParam ?? []), ...(stm?.currentConstraints ?? [])];
  const scored = scoreCandidates(scoredInput as any, profile, allConstraints, memoryEnabled);
  const picks = selectPicks(scored as any);
  const reply = buildRecommendationReply(picks, scored as any);

  return {
    skillId: "recommend",
    reply,
    candidates: scored.map(scoredToCandidate),
    picks: {
      topPick: { ...picks.topPick },
      safePick: { ...picks.safePick },
      explorePick: { ...picks.explorePick },
      avoidOrCaution: { ...picks.avoidOrCaution },
    },
    profileSummary: profile?.summary ?? "",
    errors: [],
  };
}

// ── Main execute ──

export async function execute(
  ctx: AgentContext,
  params: Record<string, unknown>,
): Promise<SkillResult> {
  // Path 1: Image mode
  if (ctx.hasImage && ctx.imageDataUrl) {
    return handleImage(ctx);
  }

  // Path 2: Follow-up (has active menu + constraint-like text)
  if (looksLikeFollowUp(ctx.lastUserText)) {
    const { readShortTermMemory } = await import("@/lib/beer-agent/memory/short-term");
    const stm = await readShortTermMemory(ctx.conversationId).catch(() => null);
    if ((stm?.lastMenu?.candidates?.length ?? 0) > 0) {
      return handleFollowUp(ctx);
    }
  }

  // Path 3: Text-only
  return handleText(ctx, params);
}

// ── Helpers ──

function scoredToCandidate(s: any): BeerCandidate {
  return {
    candidateId: s.candidateId,
    menuIndex: s.menuIndex,
    displayName: s.displayName,
    brewery: s.brewery || "",
    style: s.style || "",
    abv: s.abv || 0,
    ibu: null,
    hops: [],
    worthScore: s.worthScore,
    fitScore: s.fitScore,
    riskFlags: s.riskFlags || [],
    reason: s.reason || "",
    evidence: [],
    untappdScore: s.rating ?? null,
    untappdRatingCount: s.ratingsCount ?? null,
  };
}

function looksLikeFollowUp(text: string): boolean {
  const patterns = [
    /^有.*吗$/, /^有没有/, /第\d+个/, /第\d+号/, /第\d+款/, /第\d+杯/,
    /哪个.*便宜/, /哪个.*好/, /怎么.*样/, /不苦/, /不要太苦/,
    /清爽的/, /烈的/, /淡的/, /IPA/, /ipa/, /拉格/, /世涛/,
    /皮尔森/, /小麦/, /酸的/, /便宜的/, /贵的/, /多少钱/,
    /介绍.*第/, /说说.*第/, /尝新/, /特别/, /预算/,
  ];
  return patterns.some((p) => p.test(text));
}

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
  if (/便宜|预算|省钱/i.test(text)) c.push("budget");
  return c;
}

function matchConstraint(c: any, constraint: string): boolean {
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

function extractBeerSegments(text: string): string[] {
  const parts = text.split(/[\n\r,，、;；。\t]+/);
  return parts
    .map((p) => p.trim())
    .filter((p) => {
      if (!p || p.length < 2) return false;
      const stopWords = ["推荐", "帮我看", "看看", "帮我", "建议", "好喝", "什么", "怎么", "如何", "这个", "那个", "哪个", "第", "杯", "预算", "配餐", "清爽", "不苦"];
      for (const sw of stopWords) {
        if (p.length <= 6 && p.includes(sw)) return false;
      }
      return true;
    });
}

function genericRecommendationQueries(text: string): string[] {
  const queries: string[] = [];
  if (/west\s*coast\s*ipa|西海岸/i.test(text)) queries.push("West Coast IPA");
  if (/hazy\s*ipa|浑浊\s*IPA/i.test(text)) queries.push("Hazy IPA");
  if (/IPA|ipa/i.test(text)) { queries.push("West Coast IPA"); queries.push("IPA"); }
  if (/拉格|lager|皮尔森|pils/i.test(text)) queries.push("Lager");
  if (/世涛|stout/i.test(text)) queries.push("Stout");
  if (/酸|sour|gose/i.test(text)) queries.push("Sour");
  if (/小麦|wheat|白啤|wit/i.test(text)) queries.push("Wheat Beer");
  if (/清爽|不苦|淡|light/i.test(text)) queries.push("Pilsner", "Session IPA");
  if (/烈|重口|帝国|double|imperial/i.test(text)) queries.push("Imperial Stout", "Double IPA");
  if (queries.length === 0) queries.push("IPA", "Stout", "Lager", "Sour");
  return [...new Set(queries)].slice(0, 4);
}
