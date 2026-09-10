import type { BeerCandidate } from "./types";
import type { ExtractedItem, ProgressCallback } from "./multi-stage-pipeline";
import { runMultiStagePipeline } from "./multi-stage-pipeline";
import { enrichCandidates, lookupBeers, lookupBreweryStats, matchesExactBeerIdentity, type EnrichedBeer, type BeerLookupResult } from "./beer-db/pipeline";
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
    skipRecommendation: true,
  });

  const ocrItems = (pipeline.extracted?.items ?? []).map(recoverOcrTitle);
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
    dbLookups = await lookupBeers(enrichInputs.map(x => x.beerName), enrichInputs.map(x => x.brewery));
  } catch (err) {
    console.warn("[provider] local db lookup failed:", err);
  }

  // 酒厂级兜底:酒款与 web 富化都没分时,若 OCR 提取到了酒厂且库内该厂
  // 有 ≥3 款,保留厂级统计作背景证据,不能当作这款酒的评分。
  const breweryHits: (BreweryLookupResult | null)[] = new Array(enrichInputs.length).fill(null);
  try {
    for (let i = 0; i < enrichInputs.length; i++) {
      const hasScore =
        (enrichedBeers[i]?.verified && enrichedBeers[i]?.untappdScore != null) ||
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

  const candidates = assembleImageCandidates(ocrItems, enrichedBeers, dbLookups, breweryHits);
  const enrichmentLog: Array<Record<string, unknown>> = [];

  for (let i = 0; i < ocrItems.length; i++) {
    const item = ocrItems[i];
    const enriched = enrichedBeers[i] ?? null;
    emit({ type: "enrich_progress", done: i, total: ocrItems.length, label: item.beerName });

    const candidate = ocrItemToCandidate(item, i, enriched, dbLookups[i] ?? null, breweryHits[i]);
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

// ── Build candidates from OCR items + independently sourced beer data ──

type OcrCandidateItem = Partial<ExtractedItem>;

/** A poster title can be transcribed correctly yet put in the wrong field.
 * Recover only an independently visible heading in the same OCR block.
 */
function recoverOcrTitle<T extends OcrCandidateItem>(item:T):T {
  item={...item,brewery:item.brewery?.replace(/\s*\|\s*(?:US|USA|CN|CHN|JP|JPN|UK|GB|GBR|RU|RUS|BE|BEL|DE|DEU|CA|CAN|AU|AUS|NZ|NZL)\s*$/i,"").trim()};
  const styleOnly=(value:string)=>value.replace(/west coast|double|triple|imperial|hazy|session|india pale ale|pale ale|ipa|neipa|lager|stout|porter|sour|wheat|西海岸|双倍|三倍|帝国|浑浊|拉格|世涛|小麦|酸啤|\s+/ig,'')==='';
  if (!item.beerName || !styleOnly(item.beerName)) return item;
  const lines=item.rawText?.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)??[];
  const heading=lines[0]??'';
  if(lines.length<2 || !heading || heading.length>60 || styleOnly(heading) || /untappd|ABV|[¥￥#%]|\d{4}|获奖|评分|新品|发布/i.test(heading) || !styleOnly(lines[1])) return item;
  return {...item,beerName:heading};
}


/** Keep one candidate per beer/brewery/serving offer, even if OCR repeats a row. */
export function assembleImageCandidates(
  items: OcrCandidateItem[],
  enriched: (EnrichedBeer | null)[] = [],
  dbHits: (BeerLookupResult | null)[] = [],
  breweryHits: (BreweryLookupResult | null)[] = [],
): BeerCandidate[] {
  const candidates: BeerCandidate[] = [];
  const identities = new Map<string, BeerCandidate>();
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  items.map(recoverOcrTitle).forEach((item, index) => {
    const candidate = ocrItemToCandidate(item, index, enriched[index] ?? null, dbHits[index] ?? null, breweryHits[index] ?? null);
    const offer = [candidate.volumeMl ?? normalize(item.serving ?? ""), candidate.price];
    // OCR identity remains usable when only one occurrence found a DB record.
    const keys = [JSON.stringify(["ocr", normalize(item.beerName ?? "") || `unknown:${index}`, normalize(item.brewery ?? ""), ...offer])];
    if (candidate.untappdId) keys.push(JSON.stringify(["db", candidate.untappdId, normalize(candidate.brewery), ...offer]));
    const existing = keys.map(key => identities.get(key)).find(Boolean);
    if (!existing) {
      candidates.push(candidate);
      keys.forEach(key => identities.set(key, candidate));
      return;
    }
    const evidence = [...existing.evidence];
    for (const entry of candidate.evidence) {
      if (!evidence.some(e => e.source === entry.source && e.summary === entry.summary)) evidence.push(entry);
    }
    if (existing.untappdScore == null && candidate.untappdScore != null) {
      // Import the rating and its provenance together; a sparse duplicate must
      // not overwrite factual OCR fields or the first occurrence's identity.
      existing.untappdId = candidate.untappdId;
      existing.untappdScore = candidate.untappdScore;
      existing.untappdRatingCount = candidate.untappdRatingCount;
      existing.untappdUrl = candidate.untappdUrl;
      existing.pricePerMl = candidate.pricePerMl ?? existing.pricePerMl;
      existing.valueScore = candidate.valueScore ?? existing.valueScore;
      existing.originBenchmark = candidate.originBenchmark ?? existing.originBenchmark;
      existing.savingsVsOrigin = candidate.savingsVsOrigin ?? existing.savingsVsOrigin;
    }
    if (!existing.style) existing.style = candidate.style;
    if (!existing.brewery) existing.brewery = candidate.brewery;
    if (!existing.abv) existing.abv = candidate.abv;
    existing.ibu ??= candidate.ibu;
    existing.breweryCountry ??= candidate.breweryCountry;
    existing.labelImage ??= candidate.labelImage;
    existing.riskFlags = [...new Set([...existing.riskFlags, ...candidate.riskFlags])];
    existing.evidence = evidence;
    keys.forEach(key => identities.set(key, existing));
  });
  return candidates;
}

function ocrItemToCandidate(
  item: OcrCandidateItem,
  idx: number,
  enriched: EnrichedBeer | null,
  dbHit: BeerLookupResult | null,
  breweryHit: BreweryLookupResult | null,
): BeerCandidate {
  const base: BeerCandidate = {
    candidateId: `ocr_${idx + 1}`,
    menuIndex: item.menuIndex || idx + 1,
    displayName: item.beerName?.trim() || `Unknown #${idx + 1}`,
    brewery: item.brewery?.trim() || "",
    style: item.style?.trim() || "",
    abv: item.abv || 0,
    ibu: item.ibu ?? null,
    hops: [],
    worthScore: 50,
    fitScore: 50,
    riskFlags: [],
    reason: "",
    evidence: [{
      source: "ocr",
      confidence: item.confidence ?? 0.5,
      summary: item.rawText?.trim() || [item.beerName, item.brewery, item.style, item.serving].filter(Boolean).join(" | "),
    }],
    price: item.price ?? null,
    volumeMl: parseServingMl(item.serving ?? ""),
  };

  // An enrichment search result may be unverified. Neither it nor advertising
  // text on the image establishes a rating for this beer.
  const query = item.beerName ?? "";
  if (enriched?.verified && matchesExactBeerIdentity(query, { name: enriched.beerName, brewery: enriched.breweryName }, item.brewery ?? "")) {
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
    base.evidence.push({ source: "untappd", confidence: enriched.confidence ?? 0.85,
      summary: `已核验 ${enriched.breweryName} / ${enriched.beerName}：${enriched.untappdScore ?? "暂无评分"} ${enriched.untappdUrl ?? ""}` });
    if (!base.abv && enriched.abv) base.abv = enriched.abv;
    if (!base.style && enriched.style) base.style = enriched.style;
    if (!base.brewery && enriched.breweryName) base.brewery = enriched.breweryName;
  }

  if (dbHit?.found && dbHit.data && matchesExactBeerIdentity(query, dbHit.data, item.brewery ?? "")) {
    const d = dbHit.data;
    const source = String(d.source);
    const verifiedCache = (d as typeof d & { verified?: boolean }).verified === true;
    // Legacy cache rows lacking a verified flag do not establish rating facts.
    if (source !== "beer_cache" || verifiedCache) {
      base.untappdId = String(d.id);
      base.untappdScore = d.rating ?? undefined;
      base.untappdRatingCount = d.ratings_count ?? undefined;
      base.untappdUrl = d.untappd_url ?? undefined;
      base.breweryCountry = d.country ?? base.breweryCountry;
      base.labelImage = d.label_image ?? base.labelImage;
      base.evidence.push({
        source: source === "ratebeer" ? "agent_inference" : "untappd", confidence: 0.95,
        summary: `本地 ${source} 酒款记录：${d.brewery} / ${d.name}，评分 ${d.rating ?? "未知"}，${d.ratings_count ?? 0} 次评分 ${d.untappd_url ?? ""}`,
      });
      if (!base.abv && d.abv) base.abv = d.abv;
      if (!base.style && d.style) base.style = d.style;
      if (!base.brewery && d.brewery) base.brewery = d.brewery;
    }
  }

  if (breweryHit?.found && breweryHit.brewery_stats && base.untappdScore == null) {
    const stats = breweryHit.brewery_stats;
    const top = breweryHit.top_beers?.[0];
    if (stats.avg_rating != null) {
      base.evidence.push({
        source: "agent_inference", confidence: 0.5,
        summary: `酒厂背景（非本款评分）：${top?.brewery ?? base.brewery} 库内 ${stats.count} 款均分 ${stats.avg_rating}；本款评分未知。`,
      });
    }
    if (!base.breweryCountry && top?.country) base.breweryCountry = top.country;
  }

  if (base.brewery && base.untappdId == null) base.riskFlags.push("酒厂名称未独立核验");
  return base;
}

function parseServingMl(serving: string): number | null {
  if (!serving) return null;
  const m = serving.match(/(\d+(?:\.\d+)?)\s*ml/i);
  if (m) return Number(m[1]);
  const pint = serving.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(?:half|1\/2|½|0\.5|半)\s*(?:pint|品脱)$/.test(pint)) return 473 / 2;
  if (/^(?:quarter|1\/4|¼|0\.25|四分之一)\s*(?:pint|品脱)$/.test(pint)) return 473 / 4;
  if (/^(?:1\s*)?(?:pint|品脱)$/.test(pint)) return 473;
  if (/品脱|pint/i.test(serving)) return null;
  if (/oz|盎司/i.test(serving)) {
    const m2 = serving.match(/(\d+(?:\.\d+)?)/);
    if (m2) return Number(m2[1]) * 29.57;
  }
  return null;
}
