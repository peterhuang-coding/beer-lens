/**
 * Beer DB — unified pipeline entry point.
 *
 * External code should import from this module or from "./pipeline" directly.
 * Internal modules (data-layer, enricher, cache, value-calc, untappd-*) are
 * not re-exported — they are implementation details of the pipeline.
 */

// ── Pipeline (public API) ──
export {
  lookupBeers,
  lookupBeer,
  enrichCandidate,
  enrichCandidates,
  getStats,
  getHotCacheStats,
  searchHotCache,
  refreshCache,
} from "./pipeline";

export type {
  BeerLookupResult,
  EnrichInput,
  DbStats,
  BeerResult,
  EnrichedBeer,
  BeerCacheEntry,
  PriceInfo,
  ValueResult,
} from "./pipeline";

// ── Internal re-exports (for backward compat during migration) ──
// These will be removed once all callers use pipeline directly.
export { enrichBeer, enrichBeers } from "./enricher";
export type { EnrichedBeer as _EnrichedBeer } from "./enricher";
export { calcValueScore, formatValueScore, formatPriceInfo } from "./value-calc";
export type { PriceInfo as _PriceInfo, ValueResult as _ValueResult } from "./value-calc";
export { batchLookupBeers, searchBeer, getBeerInfo, batchSearchBeers } from "./data-layer";
export type { BeerResult as _BeerResult, SearchResult, BeerDetails as Beer } from "./data-layer";
export { getCacheStats } from "./cache";
export type { BeerCacheEntry as _BeerCacheEntry } from "./cache";
