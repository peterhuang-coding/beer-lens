import type { AgentRequest, AgentResponse, BeerCandidate } from "./types";
import type { ProgressCallback, PipelineEvent, ExtractedItem } from "./multi-stage-pipeline";
import { runOpenRouterBeerAgent } from "./openrouter-provider";
import { runMultiStagePipeline } from "./multi-stage-pipeline";
import { getProfileSummary } from "./profile";
import { enrichBeers, type EnrichedBeer } from "./beer-db/enricher";
import { benchmarkQuestions } from "./benchmark";

export type { PipelineEvent };

export async function runBeerAgent(
  request: AgentRequest,
  onProgress?: ProgressCallback,
): Promise<AgentResponse> {
  if (process.env.BEER_AGENT_API_URL) {
    return callExternalBeerAgent(request);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("请在 .env.local 中配置 OPENROUTER_API_KEY，当前无任何后端模型可用。");
  }

  if (request.image?.dataUrl) {
    const lastUserMessage = request.messages.at(-1)?.content ?? "";
    const profileSummary = await getProfileSummary();
    return runImagePipeline(apiKey, request.image.dataUrl, lastUserMessage, profileSummary, onProgress);
  }

  return runOpenRouterBeerAgent(request);
}

// ── Image pipeline: OCR → enrich → score → recommend ──

async function runImagePipeline(
  apiKey: string,
  imageDataUrl: string,
  userText: string,
  profileSummary: string,
  onProgress?: ProgressCallback,
): Promise<AgentResponse> {
  const emit = onProgress ?? (() => {});

  const pipeline = await runMultiStagePipeline({
    apiKey,
    imageDataUrl,
    userText,
    profile: profileSummary,
    onProgress: emit,
  });

  // Build candidates directly from OCR items (real data, no LLM hallucination)
  const ocrItems = pipeline.extracted?.items ?? [];

  emit({ type: "enrich_start", count: ocrItems.length });

  // Batch enrich all beers in ONE LLM call
  const enrichInputs = ocrItems.map(item => ({
    beerName: item.beerName || "Unknown",
    brewery: item.brewery || "",
    style: item.style || "",
    abv: item.abv || 0,
    price: item.price ?? undefined,
    volumeMl: parseServingMl(item.serving) ?? undefined,
  }));

  let enrichedBeers: EnrichedBeer[];
  try {
    enrichedBeers = await enrichBeers(enrichInputs);
  } catch (err) {
    console.warn("[provider] batch enrichment failed:", err);
    enrichedBeers = [];
  }

  const candidates: BeerCandidate[] = [];
  const enrichmentLog: Array<{
    name: string;
    untappdScore: number | null;
    ratingCount: number | null;
    untappdUrl: string | null;
    usBenchmark: number | null;
    savingsVsUS: number | null;
    pricingBasis: string | null;
    verified: boolean;
    price: number | null;
    volumeMl: number | null;
    found: boolean;
  }> = [];
  for (let i = 0; i < ocrItems.length; i++) {
    const item = ocrItems[i];
    const enriched = enrichedBeers[i] ?? null;
    emit({ type: "enrich_progress", done: i, total: ocrItems.length, label: item.beerName });

    const candidate = ocrItemToCandidate(item, i, enriched);
    candidates.push(candidate);
    enrichmentLog.push({
      name: candidate.displayName,
      untappdScore: candidate.untappdScore,
      ratingCount: candidate.untappdRatingCount,
      untappdUrl: candidate.untappdUrl,
      usBenchmark: candidate.usBenchmark,
      savingsVsUS: candidate.savingsVsUS,
      pricingBasis: enriched?.pricingBasis ?? null,
      verified: enriched?.verified ?? false,
      price: candidate.price,
      volumeMl: candidate.volumeMl,
      found: candidate.untappdScore != null,
    });
  }

  emit({ type: "enrich_done" });

  // Sort by combined score
  const sorted = candidates.sort(
    (a, b) => b.worthScore + b.fitScore - (a.worthScore + a.fitScore)
  );

  // Map LLM picks to actual candidates
  const rec = pipeline.recommendation;
  const findById = (id: string) =>
    sorted.find(c => c.candidateId === id || String(c.menuIndex) === id);

  const top = findById(rec.topPickId) ?? sorted[0] ?? emptyCandidate();
  const safe = findById(rec.safePickId) ?? sorted.find(c => /pils|lager|pale|小麦|拉格|皮尔森/i.test(c.style)) ?? top;
  const explore = findById(rec.explorePickId) ?? sorted.find(c => c.riskFlags.length > 0 || c.fitScore < 70) ?? top;
  const caution = findById(rec.avoidPickId) ?? [...sorted].sort((a, b) => a.fitScore - b.fitScore)[0] ?? top;

  return {
    mode: "recommend",
    reply: rec.reply,
    candidates: sorted,
    picks: {
      topPick: toPick(top, "如果只能喝一杯", rec.topReason),
      safePick: toPick(safe, "最稳", rec.safeReason),
      explorePick: toPick(explore, "最值得尝新", rec.exploreReason),
      avoidOrCaution: toPick(caution, "我会谨慎", rec.avoidReason),
    },
    benchmarkPrompt: benchmarkQuestions,
    profileSummary,
    stages: {
      imageContext: pipeline.imageContext ?? undefined,
      extracted: pipeline.extracted ?? undefined,
      visualQuality: pipeline.visualQuality ?? undefined,
      enrichment: enrichmentLog,
    },
  };
}

// ── Build candidate from OCR item + Untappd enrichment ──

function ocrItemToCandidate(item: ExtractedItem, idx: number, enriched: EnrichedBeer | null): BeerCandidate {
  const base: BeerCandidate = {
    candidateId: String(item.menuIndex || `ocr_${idx}`),
    menuIndex: item.menuIndex || idx + 1,
    displayName: item.beerName || `Unknown #${idx + 1}`,
    brewery: item.brewery || "",
    style: item.style || "",
    abv: item.abv || 0,
    ibu: item.ibu,
    hops: [],
    worthScore: 50,
    fitScore: 50,
    riskFlags: [],
    reason: "",
    evidence: [],
    price: item.price,
    volumeMl: parseServingMl(item.serving),
  };

  if (enriched) {
    base.untappdId = enriched.untappdId;
    base.untappdScore = enriched.untappdScore;
    base.untappdRatingCount = enriched.untappdRatingCount;
    base.untappdUrl = enriched.untappdUrl;
    base.breweryCountry = enriched.breweryCountry;
    base.labelImage = enriched.labelImage;
    base.pricePerMl = enriched.pricePerMl;
    base.valueScore = enriched.valueScore;
    base.usBenchmark = enriched.usBenchmark;
    base.savingsVsUS = enriched.savingsVsUS;

    if (!base.style && enriched.style) base.style = enriched.style;
    if (!base.brewery && enriched.breweryName) base.brewery = enriched.breweryName;
  }

  // Algorithmic scoring
  base.worthScore = calcWorthScore(base);
  base.fitScore = calcFitScore(base);
  base.reason = buildReason(base);

  return base;
}

// ── Scoring ──

function calcWorthScore(c: BeerCandidate): number {
  let score = 50;

  // Untappd rating is primary driver
  if (c.untappdScore) {
    score = Math.round(c.untappdScore * 20); // 4.0 → 80, 3.5 → 70
  }

  // US benchmark comparison: cheaper than US = bonus
  if (c.savingsVsUS != null) {
    score += Math.round(c.savingsVsUS * 0.15); // 20% cheaper → +3
  }

  // Visual risk flags penalty
  score -= (c.riskFlags?.length ?? 0) * 5;

  return clamp(score);
}

function calcFitScore(c: BeerCandidate): number {
  let score = 50;

  const style = (c.style ?? "").toLowerCase();

  // Match user profile: 热带水果、柑橘、清爽、低甜度
  if (/hazy|浑浊|ne ?ipa|pale ale|淡色|session/i.test(style)) score += 15;
  if (/ipa/i.test(style) && !/imperial|double|triple|帝国/i.test(style)) score += 10;
  if (/wheat|小麦|hefe|weiss/i.test(style)) score += 12;
  if (/sour|酸|gose|berliner/i.test(style)) score += 8;
  if (/lager|拉格|pils|皮尔森/i.test(style)) score += 15;

  // Penalties for mismatches
  if (/imperial|帝国|double|triple|barrel|barley.?wine/i.test(style)) score -= 10;
  if (/stout|世涛|porter/i.test(style)) score -= 5;
  if ((c.abv ?? 0) > 10) score -= 10;

  // Untappd rating influence
  if (c.untappdScore && c.untappdScore >= 4.0) score += 5;
  if (c.untappdScore && c.untappdScore < 3.5) score -= 5;

  return clamp(score);
}

function buildReason(c: BeerCandidate): string {
  const parts: string[] = [];
  if (c.untappdScore) {
    parts.push(`Untappd ${c.untappdScore.toFixed(1)}`);
    if (c.untappdRatingCount) parts.push(` (${formatCount(c.untappdRatingCount)}人评)`);
  }
  if (c.price != null && c.volumeMl != null) {
    parts.push(`¥${c.price}/${c.volumeMl}ml`);
    if (c.savingsVsUS != null && c.savingsVsUS > 0) {
      parts.push(`比美国便宜${c.savingsVsUS}%`);
    }
  }
  if (!parts.length) parts.push("信息不足");
  return parts.join(" · ");
}

function parseServingMl(serving: string): number | null {
  if (!serving) return null;
  const m = serving.match(/(\d+)\s*ml/i);
  if (m) return parseInt(m[1], 10);
  if (/品脱|pint/i.test(serving)) return 473;
  if (/oz|盎司/i.test(serving)) {
    const m2 = serving.match(/(\d+)/);
    if (m2) return parseInt(m2[1], 10) * 29.57;
  }
  return null;
}

function formatCount(n: number): string {
  return n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function emptyCandidate(): BeerCandidate {
  return {
    candidateId: "empty",
    menuIndex: 0,
    displayName: "等待候选酒",
    brewery: "",
    style: "",
    abv: 0,
    hops: [],
    worthScore: 0,
    fitScore: 0,
    riskFlags: [],
    reason: "还没有足够信息。",
    evidence: [],
    price: null,
    volumeMl: null,
  };
}

function toPick(candidate: BeerCandidate, label: string, fallbackReason?: string) {
  return {
    candidateId: candidate.candidateId,
    label,
    reason: candidate.reason || fallbackReason || "暂无",
    worthScore: candidate.worthScore,
    fitScore: candidate.fitScore,
  };
}

function clamp(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function callExternalBeerAgent(request: AgentRequest): Promise<AgentResponse> {
  const response = await fetch(process.env.BEER_AGENT_API_URL as string, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.BEER_AGENT_API_KEY
        ? { authorization: `Bearer ${process.env.BEER_AGENT_API_KEY}` }
        : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Beer agent API failed: ${response.status}`);
  }

  return response.json() as Promise<AgentResponse>;
}
