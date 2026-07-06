import { getFromCache, putToCache, searchCacheByName } from "./cache";
import { batchSearchBeers } from "./untappd-client";
import { verifyUntappdRating } from "./untappd-verify";
import { calcValueScore } from "./value-calc";
import type { BeerCacheEntry } from "./cache";

export type EnrichedBeer = {
  beerName: string;
  breweryName: string;
  style: string;
  abv: number;
  ibu: number | null;
  hops: string[];
  untappdId: string | null;
  untappdScore: number | null;
  untappdRatingCount: number | null;
  untappdUrl: string | null;
  breweryCountry: string | null;
  labelImage: string | null;
  // pricing
  price: number | null;
  volumeMl: number | null;
  pricePerMl: number | null;
  valueScore: number | null;
  originBenchmark: number | null;
  savingsVsOrigin: number | null;
  pricingBasis: string | null;
  // meta
  source: "untappd" | "cache" | "none";
  verified: boolean;
  confidence: number;
};

type EnricherInput = {
  beerName: string;
  brewery?: string;
  style?: string;
  abv?: number;
  hops?: string[];
  price?: number;
  volumeMl?: number;
  confidence?: number;
};

// ── Single beer enrichment (for text-only mode) ──

export async function enrichBeer(input: EnricherInput): Promise<EnrichedBeer> {
  const base = makeBase(input);

  try {
    const cacheHits = await searchCacheByName(input.beerName);
    if (cacheHits.length > 0) {
      return applyHit(base, cacheHits[0], "cache");
    }
  } catch { /* proceed */ }

  try {
    const query = [input.beerName, input.brewery].filter(Boolean).join(" ");
    const results = await batchSearchBeers([query]);
    if (results.length > 0 && results[0].rating > 0) {
      return applyUntappdResult(base, results[0]);
    }
  } catch { /* fall through */ }

  return base;
}

// ── Batch enrichment (one LLM call for all beers) ──

export async function enrichBeers(inputs: EnricherInput[]): Promise<EnrichedBeer[]> {
  if (inputs.length === 0) return [];

  // Build search queries: "beerName brewery"
  const queries = inputs.map(i =>
    [i.beerName, i.brewery].filter(Boolean).join(" ")
  );

  let results;
  try {
    results = await batchSearchBeers(queries);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[enricher] batch lookup failed: ${msg}`);
    return inputs.map(makeBase);
  }

  const enriched = inputs.map((input, i) => {
    const base = makeBase(input);
    const result = results?.[i];
    if (result && result.rating > 0) {
      return applyUntappdResult(base, result);
    }
    return base;
  });

  // Background: try to verify ratings via web search (fires cache updates for next time)
  verifyAndCache(enriched).catch(err =>
    console.warn(`[enricher] verification pass failed: ${err instanceof Error ? err.message : err}`)
  );

  return enriched;
}

function makeBase(input: EnricherInput): EnrichedBeer {
  return {
    beerName: input.beerName,
    breweryName: input.brewery ?? "",
    style: input.style ?? "",
    abv: input.abv ?? 0,
    ibu: null,
    hops: input.hops ?? [],
    untappdId: null,
    untappdScore: null,
    untappdRatingCount: null,
    untappdUrl: null,
    breweryCountry: null,
    labelImage: null,
    price: input.price ?? null,
    volumeMl: input.volumeMl ?? null,
    pricePerMl: null,
    valueScore: null,
    originBenchmark: null,
    savingsVsOrigin: null,
    pricingBasis: null,
    source: "none",
    verified: false,
    confidence: input.confidence ?? 0.5,
  };
}

function applyUntappdResult(
  base: EnrichedBeer,
  result: { id: string; name: string; brewery: string; style: string; abv: number; rating: number; url: string; numRatings?: number }
): EnrichedBeer {
  const enriched = { ...base };

  enriched.untappdId = result.id;
  enriched.untappdScore = result.rating;
  enriched.untappdRatingCount = (result as any).numRatings ?? null;
  enriched.untappdUrl = result.url;
  enriched.source = "untappd";
  enriched.verified = false; // LLM lookup needs verification
  enriched.confidence = 0.75; // AI-based lookup has moderate confidence

  if (!enriched.breweryName && result.brewery) enriched.breweryName = result.brewery;
  if (!enriched.style && result.style) enriched.style = result.style;
  if (!enriched.abv && result.abv) enriched.abv = result.abv;

  if (enriched.price !== null) {
    const priceInfo = calcValueScore({
      price: enriched.price,
      volumeMl: enriched.volumeMl,
      ratingScore: enriched.untappdScore,
      style: enriched.style,
      abv: enriched.abv,
      breweryCountry: enriched.breweryCountry,
    });
    enriched.pricePerMl = priceInfo.pricePerMl;
    enriched.valueScore = priceInfo.valueScore;
    enriched.originBenchmark = priceInfo.originBenchmark;
    enriched.savingsVsOrigin = priceInfo.savingsVsOrigin;
    enriched.pricingBasis = priceInfo.pricingBasis;
  }

  return enriched;
}

// Re-export applyHit for backward compat
function applyHit(base: EnrichedBeer, entry: BeerCacheEntry, source: "untappd" | "cache"): EnrichedBeer {
  const enriched = { ...base };
  enriched.untappdId = entry.id;
  enriched.untappdScore = entry.ratingScore;
  enriched.untappdRatingCount = entry.ratingCount;
  enriched.untappdUrl = entry.untappdUrl;
  enriched.breweryCountry = entry.breweryCountry;
  enriched.labelImage = entry.labelImage;
  enriched.source = source;
  enriched.verified = entry.verified === true; // cache entries may be verified
  enriched.confidence = source === "cache" ? 0.85 : 0.88;
  if (!enriched.breweryName) enriched.breweryName = entry.breweryName;
  if (!enriched.style) enriched.style = entry.style;
  if (!enriched.abv) enriched.abv = entry.abv;

  if (enriched.price !== null) {
    const priceInfo = calcValueScore({
      price: enriched.price,
      volumeMl: enriched.volumeMl,
      ratingScore: enriched.untappdScore,
      style: enriched.style,
      abv: enriched.abv,
      breweryCountry: enriched.breweryCountry,
    });
    enriched.pricePerMl = priceInfo.pricePerMl;
    enriched.valueScore = priceInfo.valueScore;
    enriched.originBenchmark = priceInfo.originBenchmark;
    enriched.savingsVsOrigin = priceInfo.savingsVsOrigin;
    enriched.pricingBasis = priceInfo.pricingBasis;
  }
  return enriched;
}

// ── Background verification ──

async function verifyAndCache(enrichedBeers: EnrichedBeer[]) {
  const toVerify = enrichedBeers.filter(b => b.source === "untappd" && !b.verified && b.untappdScore != null);
  if (toVerify.length === 0) return;

  // Verify up to 5 beers per batch to avoid rate limits
  const batch = toVerify.slice(0, 5);
  const results = await Promise.allSettled(
    batch.map(async (beer) => {
      const verified = await verifyUntappdRating({
        beerName: beer.beerName,
        brewery: beer.breweryName,
      });
      if (verified && beer.untappdId) {
        // Update cache with verified data
        await putToCache({
          id: verified.untappdId || beer.untappdId,
          beerName: beer.beerName,
          breweryName: beer.breweryName,
          breweryCountry: beer.breweryCountry,
          style: beer.style,
          abv: beer.abv,
          ibu: beer.ibu,
          ratingScore: verified.rating,
          ratingCount: verified.ratingCount ?? 0,
          untappdUrl: verified.untappdUrl || beer.untappdUrl || "",
          labelImage: beer.labelImage,
          verified: true,
          cachedAt: Date.now(),
        });
      }
    })
  );

  const succeeded = results.filter(r => r.status === "fulfilled").length;
  if (succeeded > 0) {
    console.log(`[enricher] verified ${succeeded}/${batch.length} beers via web search`);
  }
}
