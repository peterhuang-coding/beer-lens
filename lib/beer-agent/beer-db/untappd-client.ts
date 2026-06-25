/**
 * Beer lookup — now powered by real SQLite database (RateBeer + Untappd cache).
 * Delegates to data-layer.ts which calls Python lookup.py.
 *
 * Previous version used LLM to hallucinate Untappd ratings.
 * Now we use real data: 14,228 beers from RateBeer Kaggle + Untappd cache.
 */
export {
  searchBeer,
  getBeerInfo,
  batchSearchBeers,
} from "./data-layer";

export type {
  SearchResult,
  BeerDetails as Beer,
} from "./data-layer";
