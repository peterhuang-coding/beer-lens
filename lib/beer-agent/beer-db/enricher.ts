import { getFromCache, putToCache, searchCacheByName } from "./cache";
import { searchBeer, getBeerInfo } from "./untappd-client";
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
  // meta
  source: "untappd" | "cache" | "none";
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

export async function enrichBeer(input: EnricherInput): Promise<EnrichedBeer> {
  const base: EnrichedBeer = {
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
    source: "none",
    confidence: input.confidence ?? 0.5,
  };

  try {
    // Step 1: local cache
    const cacheHits = await searchCacheByName(input.beerName);
    if (cacheHits.length > 0) {
      return applyHit(base, cacheHits[0], "cache");
    }
  } catch {
    // cache read failed, proceed to live search
  }

  // Step 2: search Untappd via untappd-node (scrapes public pages)
  try {
    const searchQuery = [input.beerName, input.brewery].filter(Boolean).join(" ");
    const results = await searchBeer(searchQuery);

    if (results.length === 0) return base;

    const best = findBestMatch(input.beerName, input.brewery, results);
    if (!best) return base;

    // Step 3: get full details (rating count, image)
    const full = await getBeerInfo(best.id);

    // Step 4: write to cache
    const entry: BeerCacheEntry = {
      id: best.id,
      beerName: full?.name ?? best.name,
      breweryName: best.brewery,
      breweryCountry: null, // untappd-node doesn't provide country
      style: full?.style ?? best.style,
      abv: full?.abv ?? best.abv ?? 0,
      ibu: null,
      ratingScore: full?.rating ?? best.rating,
      ratingCount: full?.numRatings ?? 0,
      untappdUrl: best.url,
      labelImage: full?.image ?? null,
      cachedAt: Date.now(),
    };

    await putToCache(entry).catch(() => {});

    return applyHit(base, entry, "untappd");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[enricher] Untappd lookup failed for "${input.beerName}": ${message}`);
    return base;
  }
}

export async function enrichBeers(inputs: EnricherInput[]): Promise<EnrichedBeer[]> {
  return Promise.all(inputs.map(enrichBeer));
}

function findBestMatch(
  queryBeer: string,
  queryBrewery: string | undefined,
  items: Array<{
    id: string;
    name: string;
    brewery: string;
    style: string;
    url: string;
    abv?: number;
    rating: number;
  }>
) {
  const qBeer = queryBeer.toLowerCase().replace(/^\d+\s*[号#]\s*/, "");
  const qBrewery = queryBrewery?.toLowerCase();

  const scored = items.map((item) => {
    let score = 0;
    const bName = item.name.toLowerCase();
    const bBrewery = item.brewery.toLowerCase();

    if (bName === qBeer) score += 10;
    else if (bName.includes(qBeer) || qBeer.includes(bName)) score += 5;

    if (qBrewery && bBrewery === qBrewery) score += 10;
    else if (qBrewery && (bBrewery.includes(qBrewery) || qBrewery.includes(bBrewery))) score += 5;

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.item ?? null;
}

function applyHit(
  base: EnrichedBeer,
  entry: BeerCacheEntry,
  source: "untappd" | "cache"
): EnrichedBeer {
  const enriched: EnrichedBeer = {
    ...base,
    untappdId: entry.id,
    untappdScore: entry.ratingScore,
    untappdRatingCount: entry.ratingCount,
    untappdUrl: entry.untappdUrl,
    breweryCountry: entry.breweryCountry,
    labelImage: entry.labelImage,
    source,
    confidence: source === "cache" ? 0.85 : 0.88,
  };

  // backfill from entry if original OCR was sparse
  if (!enriched.breweryName) enriched.breweryName = entry.breweryName;
  if (!enriched.style) enriched.style = entry.style;
  if (!enriched.abv) enriched.abv = entry.abv;

  // calculate value scores
  if (enriched.price !== null) {
    const priceInfo = calcValueScore({
      price: enriched.price,
      volumeMl: enriched.volumeMl,
      ratingScore: enriched.untappdScore,
    });
    enriched.pricePerMl = priceInfo.pricePerMl;
    enriched.valueScore = priceInfo.valueScore;
  }

  return enriched;
}
