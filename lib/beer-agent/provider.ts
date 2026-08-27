import type { AgentResponse, BeerCandidate } from "./types";
import type { ProgressCallback } from "./multi-stage-pipeline";
import { runMultiStagePipeline } from "./multi-stage-pipeline";
import { enrichCandidates, lookupBeers, lookupBreweryStats, type EnrichedBeer, type BeerLookupResult } from "./beer-db/pipeline";
import type { BreweryLookupResult } from "./beer-db/data-layer";

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
  if (ocrItems.length === 0) {
    console.warn("[provider] vision succeeded but extracted 0 items — 模型可能返回了空 JSON");
  }

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

  // SQLite 50k 酒库匹配(含中文别名桥)。图片路径此前完全不走本地库,
  // OCR 出的中文酒名被 web 富化吞掉 —— 这里补上本地库命中。
  let dbLookups: BeerLookupResult[] = [];
  try {
    dbLookups = await lookupBeers(enrichInputs.map((x) => x.beerName));
  } catch (err) {
    console.warn("[provider] local db lookup failed:", err);
  }

  // 酒厂级兜底:酒款与 web 富化都没分时,若 OCR 提取到了酒厂且库内该厂
  // 有 ≥3 款,用厂级统计(均分/款数/代表款)代替「无评分数据」。
  const breweryHits: (BreweryLookupResult | null)[] = new Array(enrichInputs.length).fill(null);
  try {
    for (let i = 0; i < enrichInputs.length; i++) {
      const hasScore =
        enrichedBeers[i]?.untappdScore != null ||
        (dbLookups[i]?.found && dbLookups[i].data != null);
      if (hasScore) continue;
      const bw = String(enrichInputs[i].brewery ?? "").trim();
      if (bw.length < 2) continue;
      const hit = await lookupBreweryStats(bw);
      if (hit?.found && hit.brewery_stats && hit.brewery_stats.count >= 3) {
        breweryHits[i] = hit;
      }
    }
  } catch (err) {
    console.warn("[provider] brewery fallback failed:", err);
  }

  const candidates: BeerCandidate[] = [];
  const enrichmentLog: Array<Record<string, unknown>> = [];

  for (let i = 0; i < ocrItems.length; i++) {
    const item = ocrItems[i];
    const enriched = enrichedBeers[i] ?? null;
    emit({ type: "enrich_progress", done: i, total: ocrItems.length, label: item.beerName });

    const candidate = ocrItemToCandidate(item, i, enriched, dbLookups[i] ?? null, breweryHits[i]);
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
      dbHit: dbLookups[i]?.found ?? false,
      breweryHit: breweryHits[i]?.found ?? false,
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
  dbHit: BeerLookupResult | null,
  breweryHit: BreweryLookupResult | null,
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

  // 本地 SQLite 酒库命中:补上 web 富化缺失的评分/风格/酒厂字段
  if (dbHit?.found && dbHit.data) {
    const d = dbHit.data;
    base.untappdId ??= String(d.id);
    base.untappdScore ??= d.rating ?? undefined;
    base.untappdRatingCount ??= d.ratings_count ?? undefined;
    base.untappdUrl ??= d.untappd_url ?? undefined;
    base.breweryCountry ??= d.country ?? undefined;
    if (!base.style && d.style) base.style = d.style;
    if (!base.brewery && d.brewery) base.brewery = d.brewery;
  }

  // 酒厂级兜底:诚实代理分 —— 用厂级均分,并打「非本款」标注
  if (breweryHit?.found && breweryHit.brewery_stats && base.untappdScore == null) {
    const s = breweryHit.brewery_stats;
    const top = breweryHit.top_beers?.[0];
    if (s.avg_rating != null) {
      base.untappdScore = s.avg_rating;
      base.riskFlags.push("酒厂均分(非本款)");
      base.evidence.push({
        source: "untappd",
        confidence: 0.5,
        summary: `酒厂 ${top?.brewery ?? ""} 库内 ${s.count} 款,均分 ${s.avg_rating},代表款:${top?.name ?? ""} ★${top?.rating ?? "-"}`,
      });
    }
    if (!base.breweryCountry && top?.country) base.breweryCountry = top.country;
    if (!base.brewery && top?.brewery) base.brewery = top.brewery;
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
