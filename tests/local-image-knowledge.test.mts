// Self-imported immutable fixture MUST precede every dynamic production import.
import './fixtures/image-local-stubs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── Offline sandbox: chdir into a synthetic tree BEFORE production modules
//    are imported, so cache.ts's module-level cachePath lands in the sandbox
//    and no real DB/cache/event/menu file is ever touched. ──
const sandbox = await mkdtemp(path.join(tmpdir(), 'beer-image-local-'));
process.chdir(sandbox);
await mkdir(path.join(sandbox, 'data', 'events'), { recursive: true });
await mkdir(path.join(sandbox, 'data', 'menus'), { recursive: true });

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const beerCache = {
  version: 2,
  beers: {
    ex1: { id: 'ex1', beerName: 'Exact Fresh Ale', breweryName: 'Exact Brewhouse', breweryCountry: 'BE', style: 'Belgian Ale', abv: 5.4, ibu: 22, ratingScore: 4.25, ratingCount: 100, untappdUrl: 'https://untappd.com/beer/ex1', labelImage: null, verified: true, cachedAt: NOW },
    stale1: { id: 'stale1', beerName: 'Stale Sipper', breweryName: 'Clock Brewery', breweryCountry: 'DE', style: 'Lager', abv: 4.9, ibu: null, ratingScore: 4.0, ratingCount: 50, untappdUrl: 'https://untappd.com/beer/stale1', labelImage: null, verified: true, cachedAt: NOW - 400 * DAY },
    unv1: { id: 'unv1', beerName: 'Unverified Dream', breweryName: 'Hopless Works', breweryCountry: 'US', style: 'IPA', abv: 6.8, ibu: null, ratingScore: 4.5, ratingCount: 9, untappdUrl: 'https://untappd.com/beer/unv1', labelImage: null, verified: false, cachedAt: NOW },
    fut1: { id: 'fut1', beerName: 'Future Draft', breweryName: 'Chronos Craft', breweryCountry: 'JP', style: 'Rice Lager', abv: 5, ibu: null, ratingScore: 3.8, ratingCount: 12, untappdUrl: 'https://untappd.com/beer/fut1', labelImage: null, verified: true, cachedAt: NOW + DAY },
    bad1: { id: 'bad1', beerName: 'Malformed One', breweryName: 'Bad Data Co', breweryCountry: 'US', style: 'Ale', abv: 5, ibu: null, ratingScore: 'oops', ratingCount: 3, untappdUrl: 'https://untappd.com/beer/bad1', labelImage: null, verified: true, cachedAt: NOW },
    'sc-a': { id: 'sc-a', beerName: 'Shared Classic', breweryName: 'A Side', breweryCountry: 'US', style: 'Pils', abv: 5, ibu: null, ratingScore: 4.1, ratingCount: 11, untappdUrl: 'https://untappd.com/beer/sc-a', labelImage: null, verified: true, cachedAt: NOW },
    'sc-b': { id: 'sc-b', beerName: 'Shared Classic', breweryName: 'B Side', breweryCountry: 'US', style: 'Pils', abv: 5, ibu: null, ratingScore: 4.2, ratingCount: 22, untappdUrl: 'https://untappd.com/beer/sc-b', labelImage: null, verified: true, cachedAt: NOW },
    'tc-1': { id: 'tc-1', beerName: 'Twin Conflict', breweryName: 'Same House', breweryCountry: 'US', style: 'Ale', abv: 5, ibu: null, ratingScore: 4.3, ratingCount: 33, untappdUrl: 'https://untappd.com/beer/tc-1', labelImage: null, verified: true, cachedAt: NOW },
    'tc-2': { id: 'tc-2', beerName: 'Twin Conflict', breweryName: 'Same House', breweryCountry: 'US', style: 'Ale', abv: 5, ibu: null, ratingScore: 4.4, ratingCount: 44, untappdUrl: 'https://untappd.com/beer/tc-2', labelImage: null, verified: true, cachedAt: NOW },
    phil2: { id: 'phil2', beerName: 'Philia #2', breweryName: 'Variant House', breweryCountry: 'US', style: 'Imperial IPA', abv: 8.5, ibu: null, ratingScore: 4.38, ratingCount: 181, untappdUrl: 'https://untappd.com/beer/phil2', labelImage: null, verified: true, cachedAt: NOW },
    pils: { id: 'pils', beerName: 'Plain Pils', breweryName: 'Lager Yard', breweryCountry: 'CZ', style: 'Pils', abv: 4.4, ibu: null, ratingScore: 3.9, ratingCount: 10, untappdUrl: 'https://untappd.com/beer/pils', labelImage: null, verified: true, cachedAt: NOW },
    ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => {
      const n = i + 1;
      const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven'];
      return [`pre-${String(n).padStart(2, '0')}`, {
        id: `pre-${String(n).padStart(2, '0')}`, beerName: `Prefix Storm ${words[i]}`,
        breweryName: 'Storm Branch', breweryCountry: 'US', style: 'IPA', abv: 6, ibu: null,
        ratingScore: 3.5 + n * 0.01, ratingCount: n, untappdUrl: `https://untappd.com/beer/pre-${n}`, labelImage: null, verified: true, cachedAt: NOW,
      }];
    })),
    'pre-x': { id: 'pre-x', beerName: 'Prefix Storm', breweryName: 'Storm Factory', breweryCountry: 'US', style: 'IPA', abv: 7, ibu: null, ratingScore: 4.6, ratingCount: 777, untappdUrl: 'https://untappd.com/beer/pre-x', labelImage: null, verified: true, cachedAt: NOW },
    cgold: { id: 'cgold', beerName: 'Cached Golden', breweryName: 'Cache Brewery', breweryCountry: 'US', style: 'Golden Ale', abv: 4.8, ibu: 18, ratingScore: 4.12, ratingCount: 888, untappdUrl: 'https://untappd.com/beer/cgold', labelImage: null, verified: true, cachedAt: NOW },
    ucg: { id: 'ucg', beerName: 'Unverified Cache Girl', breweryName: 'Ghost Branch', breweryCountry: 'US', style: 'Pale', abv: 5.2, ibu: null, ratingScore: 4.01, ratingCount: 4, untappdUrl: 'https://untappd.com/beer/ucg', labelImage: null, verified: false, cachedAt: NOW },
    oldver: { id: 'oldver', beerName: 'Supplementary Version', breweryName: 'Version Brewery', breweryCountry: 'US', style: 'Old IPA', abv: 8.5, ibu: null, ratingScore: 4.44, ratingCount: 444, untappdUrl: 'https://untappd.com/beer/oldver', labelImage: null, verified: true, cachedAt: NOW },
    oldbatch: { id: 'oldbatch', beerName: 'Supplementary Batch', breweryName: 'Batch Brewery', breweryCountry: 'US', style: 'Old Stout', abv: 9, ibu: null, ratingScore: 4.33, ratingCount: 333, untappdUrl: 'https://untappd.com/beer/oldbatch', labelImage: null, verified: true, cachedAt: NOW },
    badhigh: { id: 'badhigh', beerName: 'Invalid High Score', breweryName: 'Bad Data Co', breweryCountry: null, style: 'Ale', abv: 5, ibu: null, ratingScore: 99, ratingCount: 12, untappdUrl: '', labelImage: null, verified: true, cachedAt: NOW },
    badlow: { id: 'badlow', beerName: 'Invalid Low Score', breweryName: 'Bad Data Co', breweryCountry: null, style: 'Ale', abv: 5, ibu: null, ratingScore: -0.01, ratingCount: 12, untappdUrl: '', labelImage: null, verified: true, cachedAt: NOW },
    badcount: { id: 'badcount', beerName: 'Invalid Negative Count', breweryName: 'Bad Data Co', breweryCountry: null, style: 'Ale', abv: 5, ibu: null, ratingScore: 4, ratingCount: -1, untappdUrl: '', labelImage: null, verified: true, cachedAt: NOW },
    badfraction: { id: 'badfraction', beerName: 'Invalid Fractional Count', breweryName: 'Bad Data Co', breweryCountry: null, style: 'Ale', abv: 5, ibu: null, ratingScore: 4, ratingCount: 1.5, untappdUrl: '', labelImage: null, verified: true, cachedAt: NOW },
    zero1: { id: 'zero1', beerName: 'Zero Rating Placeholder', breweryName: 'Zero Brewery', breweryCountry: null, style: 'Ale', abv: 5, ibu: null, ratingScore: 0, ratingCount: 0, untappdUrl: '', labelImage: null, verified: true, cachedAt: NOW },
  },
};
await writeFile(path.join(sandbox, 'data', 'beer_cache.json'), JSON.stringify(beerCache));

const eventCatalog = [
  {
    event_id: 'mbcb-2026-red', event_beer_id: 777, name: 'Event Hazy', name_zh: null,
    brewery: 'Event Brewery', brewery_zh: null, sessions: ['red'], style: 'Hazy IPA', abv: 6.5,
    description: null, untappd_id: 909, rating_raw: 4.2, rating_count: 50, rating_usable: true,
    source_url: 'https://example.com/event', retrieved_at: '2026-10-01T00:00:00Z',
    issues: [], field_disagreements: {}, aliases: [],
  },
  {
    event_id: 'mbcb-2026-red', event_beer_id: 778, name: 'Supplementary Version', name_zh: null,
    brewery: 'Version Brewery', brewery_zh: null, sessions: ['red'], style: 'Old IPA', abv: 8.5,
    description: null, untappd_id: 910, rating_raw: 4.4, rating_count: 440, rating_usable: true,
    source_url: 'https://example.com/event-version', retrieved_at: '2026-10-01T00:00:00Z',
    issues: [], field_disagreements: {}, aliases: [],
  },
];
await writeFile(path.join(sandbox, 'data', 'events', 'mbcb-2026-red.json'), JSON.stringify(eventCatalog));

const supplementSource = { url: 'https://example.com/sup', kind: 'brewery', access: 'web_index_or_cache', checked_at: '2026-10-21', fields: ['abv', 'hops'] };
const supplementFile = {
  version: 1, menu_id: 'elnido-2026-10',
  entries: [
    {
      id: 'sup-1', menu_index: 1, menu_name: 'Supplemented Saison', name_zh: '', brewery: 'Supplement Brewery',
      brewery_aliases: [], aliases: [], identity_status: 'confirmed', canonical_name: null, style: 'Saison', abv: 5.6,
      description_zh: '', observation: { abv: null, price: null, volume_ml: null, currency: 'CNY', observed_at: '2026-10-20T00:00:00Z', source: 'menu_transcription' },
      sources: [supplementSource], sourced_facts: { hops: { values: ['Saaz'], sources: [0] } }, issues: [], field_disagreements: {},
    },
    {
      id: 'sup-2', menu_index: 2, menu_name: 'Supplementary Version', name_zh: '', brewery: 'Version Brewery',
      brewery_aliases: [], aliases: [], identity_status: 'version_unresolved', canonical_name: 'K-philia #2', style: null, abv: null,
      description_zh: '', observation: { abv: null, price: null, volume_ml: null, currency: 'CNY', observed_at: '2026-10-20T00:00:00Z', source: 'menu_transcription' },
      sources: [supplementSource], issues: [], field_disagreements: {},
    },
    {
      id: 'sup-3', menu_index: 3, menu_name: 'Supplementary Batch', name_zh: '', brewery: 'Batch Brewery',
      brewery_aliases: [], aliases: [], identity_status: 'batch_unresolved', canonical_name: null, style: null, abv: null,
      description_zh: '', observation: { abv: null, price: null, volume_ml: null, currency: 'CNY', observed_at: '2026-10-20T00:00:00Z', source: 'menu_transcription' },
      sources: [supplementSource], issues: [], field_disagreements: {},
    },
  ],
};
await writeFile(path.join(sandbox, 'data', 'menus', 'elnido-2026-10.json'), JSON.stringify(supplementFile));

// ── Test-owned boundary fakes: one vision stub, local DB stub, counters for
//    the boundaries that must stay silent in the image path. ──
const calls = { vision: 0, lookup: 0, search: 0, verify: 0, brewery: 0, breweryBatch: 0, searchBeer: 0, info: 0 };
let breweryQueries: string[] = [];
function resetCalls() { for (const k of Object.keys(calls)) (calls as Record<string, number>)[k] = 0; }
const dbRows: Record<string, any> = {
  'Local DB Stout': { id: '4242', name: 'Local DB Stout', brewery: 'DB Brewery', rating: 3.95, ratings_count: 1234, untappd_url: 'https://untappd.com/beer/4242', country: 'US', style: 'Stout', abv: 6.2, source: 'ratebeer', label_image: null },
  'DB Only Mild': { id: '4243', name: 'DB Only Mild', brewery: 'No Rating Branch', rating: null, ratings_count: 0, untappd_url: 'https://untappd.com/beer/4243', country: 'GB', style: 'Mild', abv: 3.6, source: 'untappd_cache', label_image: null },
  'Supplementary Version': { id: 'old-db-version', name: 'Supplementary Version', brewery: 'Version Brewery', rating: 4.4, ratings_count: 440, untappd_url: 'https://untappd.com/beer/old-db-version', country: 'US', style: 'Old IPA', abv: 8.5, source: 'untappd', label_image: null },
  'Supplementary Batch': { id: 'old-db-batch', name: 'Supplementary Batch', brewery: 'Batch Brewery', rating: 4.3, ratings_count: 330, untappd_url: 'https://untappd.com/beer/old-db-batch', country: 'US', style: 'Old Stout', abv: 9, source: 'untappd', label_image: null },
};
const ocrItems = [
  { beerName: 'Cached Golden', brewery: 'Cache Brewery', style: 'Golden Ale', abv: 4.8, price: 60, serving: '330ml', confidence: 0.9, rawText: 'Cached Golden\nCache Brewery' },
  { beerName: 'Local DB Stout', brewery: 'DB Brewery', style: 'Stout', abv: 6.2, price: 70, serving: '330ml', confidence: 0.9 },
  { beerName: 'DB Only Mild', brewery: 'No Rating Branch', style: 'Mild', abv: 3.6, price: 50, serving: '300ml', confidence: 0.9 },
  { beerName: 'Event Hazy', brewery: 'Event Brewery', abv: 6.5, price: 66, serving: '330ml', confidence: 0.9 },
  { beerName: 'Supplemented Saison', brewery: 'Supplement Brewery', price: 55, serving: '330ml', confidence: 0.9 },
  { beerName: 'Supplementary Version', brewery: 'Version Brewery', price: 58, serving: '330ml', confidence: 0.9 },
  { beerName: 'Supplementary Batch', brewery: 'Batch Brewery', price: 68, serving: '330ml', confidence: 0.9 },
  { beerName: 'Mystery IPA', brewery: 'Unknown Branch', price: 62, serving: '330ml', confidence: 0.9 },
  { beerName: 'Mystery IPA', brewery: 'Unknown Branch', price: 68, serving: '473ml', confidence: 0.9 },
  { beerName: 'Unverified Cache Girl', brewery: 'Ghost Branch', price: 52, serving: '300ml', confidence: 0.9 },
];
(globalThis as any).__beerImageFixture = {
  async runMultiStagePipeline() {
    calls.vision++;
    return { extracted: { items: ocrItems }, imageContext: { fixture: true }, visualQuality: { score: 1 } };
  },
  async batchLookupBeers(queries: string[]) {
    calls.lookup++;
    return queries.map(q => {
      const key = Object.keys(dbRows).find(name => q.includes(name));
      return key ? { found: true, ...dbRows[key] } : { found: false, data: null };
    });
  },
  async getBeerDbStats() { return { total: 0 }; },
  async lookupBrewery() { calls.brewery++; return { found: false }; },
  async batchLookupBreweries(queries: string[]) { calls.breweryBatch++; breweryQueries = queries; return queries.map(query => ({ query, found: false })); },
  async searchBeer() { calls.searchBeer++; return null; },
  async getBeerInfo() { calls.info++; return null; },
  async batchSearchBeers() { calls.search++; throw new Error('batchSearchBeers must never be called by the image path'); },
  async verifyUntappdRating() { calls.verify++; throw new Error('verifyUntappdRating must never be called by the image path'); },
  async refreshDatabase() { return { added: 0, updated: 0, errors: 0 }; },
};

// Dynamic imports only after chdir + fixture installation.
const cacheMod: any = await import('../lib/beer-agent/beer-db/cache.ts');
const pipelineMod: any = await import('../lib/beer-agent/beer-db/pipeline.ts');
const providerMod: any = await import('../lib/beer-agent/provider.ts');
const queueMod: any = await import('../lib/beer-agent/beer-db/knowledge-queue.ts');
const groundingMod: any = await import('../lib/beer-agent/event-grounding.ts');
const supplementsMod: any = await import('../lib/beer-agent/menu-supplements.ts');

const flushTicks = async (ms = 25) => {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, ms));
};

const queuePath = path.join(sandbox, '.beer-data', 'menu-knowledge-pending.json');
const readQueue = async () => JSON.parse(await readFile(queuePath, 'utf8'));

// ── batchReadVerifiedCache: exact verified snapshot reads ──

test('fresh exact verified identity is returned; same-order cardinality preserved', async () => {
  const out = await cacheMod.batchReadVerifiedCache([
    { beerName: 'Nope Nope', brewery: 'Nowhere' },
    { beerName: 'Exact Fresh Ale', brewery: 'Exact Brewhouse' },
    { beerName: 'Stale Sipper', brewery: 'Clock Brewery' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0], null);
  assert.equal(out[1]?.id, 'ex1');
  assert.equal(out[1]?.verified, true);
  assert.equal(out[2], null);
  const empty = await cacheMod.batchReadVerifiedCache([]);
  assert.deepEqual(empty, []);
});

test('stale, unverified, future and malformed rows are rejected', async () => {
  const out = await cacheMod.batchReadVerifiedCache([
    { beerName: 'Stale Sipper', brewery: 'Clock Brewery' },
    { beerName: 'Unverified Dream', brewery: 'Hopless Works' },
    { beerName: 'Future Draft', brewery: 'Chronos Craft' },
    { beerName: 'Malformed One', brewery: 'Bad Data Co' },
  ]);
  assert.deepEqual(out, [null, null, null, null]);
});

test('verified rows still reject out-of-range scores and invalid counts without clamping', async () => {
  const out = await cacheMod.batchReadVerifiedCache([
    { beerName: 'Invalid High Score', brewery: 'Bad Data Co' },
    { beerName: 'Invalid Low Score', brewery: 'Bad Data Co' },
    { beerName: 'Invalid Negative Count', brewery: 'Bad Data Co' },
    { beerName: 'Invalid Fractional Count', brewery: 'Bad Data Co' },
    { beerName: 'Zero Rating Placeholder', brewery: 'Zero Brewery' },
  ]);
  assert.deepEqual(out.slice(0, 4), [null, null, null, null]);
  assert.equal(out[4]?.id, 'zero1');
  assert.equal(out[4]?.ratingScore, 0);
  assert.equal(out[4]?.ratingCount, 0);
});

test('nowMs gates staleness and future timestamps deterministically', async () => {
  const freshAtStaleTime = await cacheMod.batchReadVerifiedCache(
    [{ beerName: 'Stale Sipper', brewery: 'Clock Brewery' }],
    (beerCache.beers as any).stale1.cachedAt + 1000,
  );
  assert.equal(freshAtStaleTime[0]?.id, 'stale1');
  const futureAtLaterNow = await cacheMod.batchReadVerifiedCache(
    [{ beerName: 'Future Draft', brewery: 'Chronos Craft' }],
    NOW + 2 * DAY,
  );
  assert.equal(futureAtLaterNow[0]?.id, 'fut1');
  const nonFiniteNow = await cacheMod.batchReadVerifiedCache(
    [{ beerName: 'Exact Fresh Ale', brewery: 'Exact Brewhouse' }],
    Number.NaN,
  );
  assert.equal(nonFiniteNow[0]?.id, 'ex1');
});

test('wrong brewery, duplicate-name ambiguity and same-name id conflicts reject', async () => {
  const wrongBrewery = await cacheMod.batchReadVerifiedCache([{ beerName: 'Shared Classic', brewery: 'C Side' }]);
  assert.equal(wrongBrewery[0], null);
  const ambiguous = await cacheMod.batchReadVerifiedCache([{ beerName: 'Shared Classic' }]);
  assert.equal(ambiguous[0], null);
  const scoped = await cacheMod.batchReadVerifiedCache([{ beerName: 'Shared Classic', brewery: 'A Side' }]);
  assert.equal(scoped[0]?.id, 'sc-a');
  const twinNoBrewery = await cacheMod.batchReadVerifiedCache([{ beerName: 'Twin Conflict' }]);
  assert.equal(twinNoBrewery[0], null);
  const twinScoped = await cacheMod.batchReadVerifiedCache([{ beerName: 'Twin Conflict', brewery: 'Same House' }]);
  assert.equal(twinScoped[0], null);
});

test('partial and version titles never satisfy exact identity', async () => {
  const out = await cacheMod.batchReadVerifiedCache([
    { beerName: 'Philia', brewery: 'Variant House' },
    { beerName: 'Philia #2', brewery: 'Variant House' },
    { beerName: 'Plain Pils 2026', brewery: 'Lager Yard' },
  ]);
  assert.equal(out[0], null);
  assert.equal(out[1]?.id, 'phil2');
  assert.equal(out[2], null);
});

test('more than ten substring hits cannot hide the exact row', async () => {
  const legacy = await cacheMod.searchCacheByName('Prefix Storm');
  assert.equal(legacy.length, 10);
  assert.ok(!legacy.some((e: any) => e.id === 'pre-x'));
  const exact = await cacheMod.batchReadVerifiedCache([{ beerName: 'Prefix Storm', brewery: 'Storm Factory' }]);
  assert.equal(exact[0]?.id, 'pre-x');
  const wrongFactory = await cacheMod.batchReadVerifiedCache([{ beerName: 'Prefix Storm', brewery: 'Other Factory' }]);
  assert.equal(wrongFactory[0], null);
});

// ── readVerifiedEnrichments: cache-only EnrichedBeer mapping ──

test('readVerifiedEnrichments maps only verified cache fields and OCR price/volume', async () => {
  resetCalls();
  const out = await pipelineMod.readVerifiedEnrichments([
    { beerName: 'Cached Golden', brewery: 'Cache Brewery', price: 60, volumeMl: 330 },
    { beerName: 'No Such Beer', brewery: 'Nowhere', price: 40, volumeMl: 300 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].verified, true);
  assert.equal(out[0].source, 'cache');
  assert.equal(out[0].untappdScore, 4.12);
  assert.equal(out[0].untappdId, 'cgold');
  assert.equal(out[0].breweryCountry, 'US');
  assert.ok(Math.abs(out[0].pricePerMl - 60 / 330) < 1e-9);
  assert.equal(out[0].valueScore, null, 'unit price arithmetic must not become a rating/price value score');
  assert.equal(out[0].originBenchmark, null);
  assert.equal(out[0].savingsVsOrigin, null);
  assert.equal(out[0].pricingBasis, null);
  assert.equal(out[1].verified, false);
  assert.equal(out[1].source, 'none');
  assert.equal(out[1].price, 40);
  assert.equal(out[1].volumeMl, 300);
  assert.equal(out[1].untappdScore, null);
  await flushTicks();
  assert.equal(calls.search, 0);
  assert.equal(calls.verify, 0);
});

// ── runImagePipeline integration with real provider/pipeline/cache/grounding ──

test('image pipeline: one vision, zero search/verify, local hits retained, final unresolved gaps queued', async () => {
  resetCalls();
  const earlierCacheHits = await cacheMod.batchReadVerifiedCache([
    { beerName: 'Supplementary Version', brewery: 'Version Brewery' },
    { beerName: 'Supplementary Batch', brewery: 'Batch Brewery' },
  ]);
  assert.deepEqual(earlierCacheHits.map((entry: any) => entry?.id), ['oldver', 'oldbatch']);
  const result = await providerMod.runImagePipeline('test-key', 'data:image/png;base64,ZmFrZQ==', '', '');
  assert.equal(calls.vision, 1);
  assert.equal(calls.search, 0);
  assert.equal(calls.verify, 0);
  assert.ok(calls.lookup >= 1, 'local DB lookup must still run');
  assert.equal(calls.brewery, 0, 'no per-beer brewery subprocesses');
  assert.equal(calls.breweryBatch, 1, 'one deduplicated brewery batch per menu');
  assert.deepEqual(breweryQueries, ['Event Brewery', 'Supplement Brewery', 'Unknown Branch', 'Ghost Branch']);

  // Old enrich path was fire-and-forget; silence must survive microtask/timer drains.
  await flushTicks();
  assert.equal(calls.vision, 1);
  assert.equal(calls.search, 0);
  assert.equal(calls.verify, 0);

  const rows = result.candidates;
  assert.equal(rows.length, 10, 'all OCR rows preserved');
  const byName = (n: string) => rows.find((c: any) => c.displayName === n);

  const cached = byName('Cached Golden');
  assert.equal(cached.untappdScore, 4.12);
  assert.equal(cached.untappdId, 'cgold');
  assert.equal(cached.price, 60);
  assert.equal(cached.volumeMl, 330);
  assert.ok(Math.abs(cached.pricePerMl - 60 / 330) < 1e-9);
  assert.ok(cached.evidence.some((e: any) => e.source === 'untappd' && /已核验/.test(e.summary)));
  assert.equal(cached.dossier?.rating?.checkedAt, new Date(NOW).toISOString());
  assert.deepEqual(cached.dossier?.rating?.value, { score: 4.12, count: 888 });

  const db = byName('Local DB Stout');
  assert.equal(db.untappdScore, 3.95);
  assert.ok(db.evidence.some((e: any) => /本地 ratebeer 酒款记录/.test(e.summary)));
  assert.equal(db.dossier?.rating, null, 'legacy DB has no reliable rating snapshot date');

  // Identity known locally even without a usable rating: not a knowledge gap.
  const dbMild = byName('DB Only Mild');
  assert.equal(dbMild.untappdId, '4243');
  assert.ok(dbMild.untappdScore == null);

  const ev = byName('Event Hazy');
  assert.equal(groundingMod.getGrounding(ev)?.eventBeerId, 777);
  assert.equal(ev.untappdScore, 4.2);

  const supp = byName('Supplemented Saison');
  assert.equal(supplementsMod.getSupplementGrounding(supp)?.identityStatus, 'confirmed');
  assert.equal(supp.untappdScore, null);
  assert.deepEqual(supp.dossier?.hops?.value, ['Saaz']);
  assert.equal(supp.dossier?.hops?.url, 'https://example.com/sup');

  const versioned = byName('Supplementary Version');
  assert.equal(groundingMod.getGrounding(versioned)?.eventBeerId, 778, 'earlier event hit is visible in provenance');
  assert.equal(supplementsMod.getSupplementGrounding(versioned)?.identityStatus, 'version_unresolved');
  assert.equal(versioned.untappdScore, null, 'final unresolved identity clears earlier cache/DB/event ratings');
  assert.equal(versioned.untappdId, null);
  const batched = byName('Supplementary Batch');
  assert.equal(supplementsMod.getSupplementGrounding(batched)?.identityStatus, 'batch_unresolved');
  assert.equal(batched.untappdScore, null);
  assert.equal(batched.untappdId, null);
  assert.ok(result.stages.enrichment.some((log: any) => log.name === 'Supplementary Version' && log.dbHit));
  assert.ok(result.stages.enrichment.some((log: any) => log.name === 'Supplementary Batch' && log.dbHit));

  // No guessy origin-country pricing anywhere in candidates or trace.
  for (const c of rows) {
    assert.ok(c.originBenchmark == null, `${c.displayName} must carry no origin benchmark`);
    assert.ok(c.savingsVsOrigin == null, `${c.displayName} must carry no origin savings`);
  }
  for (const log of result.stages.enrichment) {
    assert.equal(log.originBenchmark, null);
    assert.equal(log.savingsVsOrigin, null);
    assert.equal(log.pricingBasis, null);
  }

  const file = await readQueue();
  assert.deepEqual(file.jobs, [
    { beerName: 'Supplementary Version', brewery: 'Version Brewery' },
    { beerName: 'Supplementary Batch', brewery: 'Batch Brewery' },
    { beerName: 'Mystery IPA', brewery: 'Unknown Branch' },
    { beerName: 'Unverified Cache Girl', brewery: 'Ghost Branch' },
  ]);
  assert.equal(file.version, 1);
});

test('text menu shares local verified knowledge and queues misses without search', async () => {
  resetCalls();
  const queueBefore = await readQueue();
  const { execute } = await import('../lib/skills/recommend/execute.ts');
  const text = '酒单：\nMystery IPA | Unknown Branch | ¥62 330ml\nCached Golden | Cache Brewery | ¥60 330ml';
  const result = await execute({
    userId: 'text-local-user', conversationId: 'text-local-conversation', traceId: 'text-local-trace',
    hasImage: false, lastUserText: text, messages: [{ role: 'user', content: text }], channel: 'web',
  }, {});
  await flushTicks();
  assert.equal(calls.vision, 0);
  assert.equal(calls.search, 0, 'text menu must not invoke legacy web enrichment');
  assert.equal(calls.verify, 0);
  assert.ok(calls.lookup >= 1);
  const cached = result.candidates.find((candidate: any) => candidate.displayName === 'Cached Golden');
  assert.equal(cached?.untappdScore, 4.12);
  assert.equal(cached?.evidence[0]?.source, 'manual_user_input');
  assert.match(result.reply, /整单解读（共 2 款/);
  assert.match(result.reply, /Mystery IPA/);
  assert.match(result.reply, /Cached Golden/);
  assert.deepEqual((await readQueue()).jobs, queueBefore.jobs, 'existing unknown identity is deduplicated');
});

test('generic style exploration is not an initial menu and never becomes lastMenu', async () => {
  const { execute } = await import('../lib/skills/recommend/execute.ts');
  const memoryMod: any = await import('../lib/beer-agent/memory/short-term.ts');
  const userId = 'generic-style-user';
  const conversationId = 'generic-style-conversation';
  const text = '想喝点不苦的 IPA，有什么风格建议？';
  const request = {
    userId, conversationId, traceId: 'generic-style-trace', turnId: 'generic-style-turn',
    hasImage: false, lastUserText: text, messages: [{ role: 'user', content: text }], channel: 'web',
  };
  const result = await execute(request as any, {});
  assert.ok(result.candidates.length > 0);
  assert.ok(!result.reply.includes('整单解读'), 'style exploration must not claim to read a supplied menu');
  await memoryMod.updateShortTermMemory(request, {
    traceId: 'generic-style-trace', turnId: 'generic-style-turn', reply: result.reply,
    candidates: result.candidates, picks: result.picks, intentResult: { intent: 'menu_recommend' },
  });
  const memory = await memoryMod.readShortTermMemory(conversationId, userId);
  assert.equal(memory?.lastMenu, undefined, 'synthetic style rows are not an authoritative menu');
  assert.equal(memory?.recentTurns.length, 1, 'the conversation itself is still remembered');
});

// ── knowledge queue persistence, dedupe, concurrency, safety ──

test('queue: empty and malformed jobs never write', async () => {
  const before = await readFile(queuePath, 'utf8');
  await queueMod.enqueueMenuKnowledge([]);
  await queueMod.enqueueMenuKnowledge(undefined);
  await queueMod.enqueueMenuKnowledge([null, { beer: '' }, { beerName: '', brewery: 'x' }, { beerName: 12, brewery: 'y' }]);
  const after = await readFile(queuePath, 'utf8');
  assert.equal(after, before);
  const file = JSON.parse(after);
  assert.equal(file.jobs.length, 4);
});

test('queue: repeated writes dedupe on normalized identity and stay parseable', async () => {
  await queueMod.enqueueMenuKnowledge([
    { beerName: 'Supplementary Version', brewery: 'Version Brewery' },
    { beerName: 'Alpha Ale', brewery: 'Alpha Brew' },
  ]);
  await queueMod.enqueueMenuKnowledge([
    { beerName: '  supplementary   version ', brewery: 'VERSION  brewery' },
    { beerName: 'Alpha Ale', brewery: 'Alpha Brew' },
    { beerName: 'Beta Beer', brewery: 'Beta Brew' },
  ]);
  const file = await readQueue();
  const names = file.jobs.map((j: any) => `${j.beerName}@${j.brewery}`);
  assert.deepEqual(names, [
    'Supplementary Version@Version Brewery',
    'Supplementary Batch@Batch Brewery',
    'Mystery IPA@Unknown Branch',
    'Unverified Cache Girl@Ghost Branch',
    'Alpha Ale@Alpha Brew',
    'Beta Beer@Beta Brew',
  ]);
  assert.ok(file.jobs.every((j: any) => !/\s{2,}/.test(j.beerName) && !/\s{2,}/.test(j.brewery)));
});

test('queue: concurrent calls serialize into one parseable union', async () => {
  const batches = Array.from({ length: 10 }, (_, i) => [
    { beerName: `Parallel Beer ${i} A`, brewery: `Parallel Brewery ${i}` },
    { beerName: `Parallel Beer ${i} B`, brewery: `Parallel Brewery ${i}` },
  ]);
  await Promise.all(batches.map(jobs => queueMod.enqueueMenuKnowledge(jobs)));
  const file = await readQueue();
  assert.equal(file.jobs.length, 6 + 20);
  const keys = new Set(file.jobs.map((j: any) => `${j.beerName} ${j.brewery}`));
  assert.equal(keys.size, file.jobs.length);
});

test('queue: identity strings are bounded and payload stays minimal (no PII channels)', async () => {
  await queueMod.enqueueMenuKnowledge([{ beerName: 'x'.repeat(500), brewery: 'y'.repeat(500) }]);
  const file = await readQueue();
  const long = file.jobs.find((j: any) => j.beerName.startsWith('xxx'));
  assert.ok(long.beerName.length <= 120);
  assert.ok(long.brewery.length <= 80);
  assert.deepEqual(Object.keys(file).sort(), ['jobs', 'version']);
  for (const job of file.jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['beerName', 'brewery']);
    for (const banned of ['user', 'chat', 'profile', 'ocr', 'image', 'base64', 'credential']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(job, banned), `unexpected ${banned} field`);
    }
  }
});

test('queue: corrupt stored file is never overwritten and failure does not poison later writes', async () => {
  const corrupt = '{ "version": 1, "jobs": [ broken';
  await writeFile(queuePath, corrupt);
  await assert.rejects(
    queueMod.enqueueMenuKnowledge([{ beerName: 'Should Not Persist', brewery: 'Nope' }]),
    /corrupt|invalid|unparseable/i,
  );
  assert.equal(await readFile(queuePath, 'utf8'), corrupt);

  // After an operator replaces the corrupt file with valid JSON, queuing works again.
  await writeFile(queuePath, JSON.stringify({ version: 1, jobs: [{ beerName: 'Recovered Beer', brewery: 'Recovered Brewery' }] }));
  await queueMod.enqueueMenuKnowledge([{ beerName: 'After Recovery', brewery: 'OK Brew' }]);
  const file = await readQueue();
  const names = file.jobs.map((j: any) => j.beerName);
  assert.ok(names.includes('Recovered Beer'));
  assert.ok(names.includes('After Recovery'));
  assert.ok(!names.includes('Should Not Persist'));

  await rm(sandbox, { recursive: true, force: true });
});
