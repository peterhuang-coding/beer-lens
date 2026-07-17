import type { AgentResponse, BeerCandidate } from "./types";
import type { ProgressCallback } from "./multi-stage-pipeline";
import { runMultiStagePipeline } from "./multi-stage-pipeline";
import { enrichCandidates, type EnrichedBeer } from "./beer-db/pipeline";

export type { ProgressCallback };

/**
 * runImagePipeline — Vision pipeline: OCR → enrich → scored candidates.
 * Used by menu-recommend handler when an image is provided.
 * Returns enriched candidates with Untappd data, ready for the recommendation engine.
 */
export async function runImagePipeline(
  apiKey: string,
  imageDataUrl: string,
  userText: string,
  profileSummary: string,
  onProgress?: ProgressCallback,
): Promise<{
  candidates: BeerCandidate[];
  stages: Record<string, unknown>;
}> {
  const emit = onProgress ?? (() => {});

  const pipeline = await runMultiStagePipeline({
    apiKey,
    imageDataUrl,
    userText,
    profile: profileSummary,
    onProgress: emit,
  });

  const ocrItems = pipeline.extracted?.items ?? [];

  emit({ type: "enrich_start", count: ocrItems.length });

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
    enrichedBeers = await enrichCandidates(enrichInputs);
  } catch (err) {
    console.warn("[provider] batch enrichment failed:", err);
    enrichedBeers = [];
  }

  const candidates: BeerCandidate[] = [];
  const enrichmentLog: Array<Record<string, unknown>> = [];

  for (let i = 0; i < ocrItems.length; i++) {
    const item = ocrItems[i];
    const enriched = enrichedBeers[i] ?? null;
    emit({ type: "enrich_progress", done: i, total: ocrItems.length, label: item.beerName });

    const candidate = ocrItemToCandidate(item, i, enriched);
    candidates.push(candidate);
    enrichmentLog.push({
      name: candidate.displayName,
      untappdScore: candidate.untappdScore ?? null,
      ratingCount: candidate.untappdRatingCount ?? null,
      untappdUrl: candidate.untappdUrl ?? null,
      originBenchmark: candidate.originBenchmark ?? null,
      savingsVsOrigin: candidate.savingsVsOrigin ?? null,
      pricingBasis: enriched?.pricingBasis ?? null,
      verified: enriched?.verified ?? false,
      price: candidate.price ?? null,
      volumeMl: candidate.volumeMl ?? null,
      breweryCountry: candidate.breweryCountry ?? null,
      found: candidate.untappdScore != null,
    });
  }

  emit({ type: "enrich_done" });

  return {
    candidates,
    stages: {
      imageContext: pipeline.imageContext ?? undefined,
      extracted: pipeline.extracted ?? undefined,
      visualQuality: pipeline.visualQuality ?? undefined,
      enrichment: enrichmentLog,
    },
  };
}

// ── Build candidate from OCR item + Untappd enrichment ──

function ocrItemToCandidate(
  item: { menuIndex?: number; beerName?: string; brewery?: string; style?: string; abv?: number; ibu?: number | null; price?: number | null; serving?: string },
  idx: number,
  enriched: EnrichedBeer | null,
): BeerCandidate {
  const base: BeerCandidate = {
    candidateId: String(item.menuIndex || `ocr_${idx}`),
    menuIndex: item.menuIndex || idx + 1,
    displayName: item.beerName || `Unknown #${idx + 1}`,
    brewery: item.brewery || "",
    style: item.style || "",
    abv: item.abv || 0,
    ibu: item.ibu ?? null,
    hops: [],
    worthScore: 50,
    fitScore: 50,
    riskFlags: [],
    reason: "",
    evidence: [],
    price: item.price ?? null,
    volumeMl: parseServingMl(item.serving ?? ""),
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
    base.originBenchmark = enriched.originBenchmark;
    base.savingsVsOrigin = enriched.savingsVsOrigin;

    if (!base.style && enriched.style) base.style = enriched.style;
    if (!base.brewery && enriched.breweryName) base.brewery = enriched.breweryName;
  }

  return base;
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
