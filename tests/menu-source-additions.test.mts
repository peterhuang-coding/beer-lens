// Sourced-additions regressions for the El Nido curated supplement.
//
// Covers the fixed additions file (two confirmed products + one strictly
// unresolved Arpus variant from a SEPARATE undated user photo):
//   - data/menus/elnido-2026-10-additions.json structure/source/limitations
//   - readMenuSupplements combining original 17 + additions 3 independently
//   - strict tap-independent, wrong-variant-safe grounding through the REAL
//     combined 20-entry set (groundMenuSupplements)
//   - follow-up knowledge rendering (buildMenuPromptSection) and hard gates
//   - the human source-audit document
//
// Public/synthetic data only; no image, model, DB or network use.
// Run:
//   node --experimental-strip-types --test tests/menu-source-additions.test.mts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readMenuSupplements,
  groundMenuSupplements,
  getSupplementGrounding,
  ocrMenuAbvEvidence,
  ocrMenuStyleEvidence,
  RISK_SUPPLEMENT_VERSION_UNRESOLVED,
  RISK_SUPPLEMENT_NO_RATING,
  type MenuSupplementEntry,
} from "../lib/beer-agent/menu-supplements.ts";
import { extractConstraints, constraintFailures } from "../lib/beer-agent/recommendation/constraints.ts";
import { buildMenuPromptSection } from "../lib/skills/beer-knowledge/menu-context.ts";

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));

const baseRaw = await readFile(new URL("../data/menus/elnido-2026-10.json", import.meta.url), "utf8");
const additionsRaw = await readFile(new URL("../data/menus/elnido-2026-10-additions.json", import.meta.url), "utf8");
const baseParsed = JSON.parse(baseRaw);
const additionsParsed = JSON.parse(additionsRaw);
const baseEntries: MenuSupplementEntry[] = baseParsed.entries;
const additionsEntries: MenuSupplementEntry[] = additionsParsed.entries;
const combined: MenuSupplementEntry[] = [...baseEntries, ...additionsEntries];
const addByIndex = new Map(additionsEntries.map(e => [e.menu_index, e]));

function candidate(over: Record<string, unknown> = {}) {
  return {
    candidateId: over.candidateId ?? "ocr_1",
    menuIndex: over.menuIndex ?? 0,
    displayName: over.displayName ?? "Unknown Beer",
    brewery: over.brewery ?? "",
    style: over.style ?? "",
    abv: over.abv ?? 0,
    ibu: null,
    hops: [],
    worthScore: 50,
    fitScore: 50,
    riskFlags: [...(over.riskFlags as string[] | undefined ?? [])],
    reason: "",
    evidence: over.evidence ?? [{ source: "ocr", confidence: 0.5, summary: "menu raw text" }],
    untappdId: over.untappdId ?? null,
    untappdScore: over.untappdScore ?? null,
    untappdRatingCount: over.untappdRatingCount ?? null,
    untappdUrl: over.untappdUrl ?? null,
    breweryCountry: null,
    labelImage: over.labelImage ?? null,
    currency: over.currency,
    servingMode: over.servingMode,
    price: over.price ?? null,
    volumeMl: over.volumeMl ?? null,
    pricePerMl: over.pricePerMl ?? null,
    valueScore: over.valueScore ?? null,
    originBenchmark: over.originBenchmark ?? null,
    savingsVsOrigin: over.savingsVsOrigin ?? null,
  };
}

const groundOne = (c: ReturnType<typeof candidate>, rs: MenuSupplementEntry[] = combined) =>
  groundMenuSupplements([c], rs)[0];
const socialText = (c: ReturnType<typeof candidate>) =>
  c.evidence.filter(e => e.source === "social_web")[0]?.summary ?? "";

// ── 1. Additions file: exactly three dated provenance entries ──

test("additions file: same monthly menu_id, undated-photo scope header, exactly 3 entries", () => {
  assert.equal(additionsParsed.menu_id, "elnido-2026-10");
  assert.match(additionsParsed.scope, /undated user photo/i);
  assert.match(additionsParsed.scope, /not the 2026-10-20 snapshot|NOT the 2026-10-20/i);
  assert.equal(additionsEntries.length, 3);
  assert.deepEqual(additionsEntries.map(e => e.menu_index), [1, 10, 16]);
});

test("additions: stable ids carry the additions disambiguator and never collide old #10/#16", () => {
  const oldIds = new Set(baseEntries.map(e => e.id));
  const ids = new Set<string>();
  for (const e of additionsEntries) {
    assert.match(e.id, /^elnido-2026-10-additions-(01|10|16)$/);
    assert.ok(!oldIds.has(e.id), `${e.id} must not collide with an original id`);
    ids.add(e.id);
  }
  assert.equal(ids.size, 3);
});

test("additions: every observation is the undated-user-photo transcription with photo prices/volumes", () => {
  const expected = new Map([
    [1, { abv: 5.6, price: 70, volume_ml: 425 }],
    [10, { abv: 7.8, price: 65, volume_ml: 300 }],
    [16, { abv: 4.5, price: 80, volume_ml: 300 }],
  ]);
  for (const e of additionsEntries) {
    assert.equal(e.observation.currency, "CNY");
    assert.equal(e.observation.source, "menu_transcription");
    assert.equal(e.observation.observed_at, "undated-user-photo");
    assert.deepEqual(
      { abv: e.observation.abv, price: e.observation.price, volume_ml: e.observation.volume_ml },
      expected.get(e.menu_index),
    );
    for (const s of e.sources) {
      assert.equal(s.access, "web_index_or_cache");
      assert.equal(s.checked_at, "2026-10-24");
      assert.match(s.url, /^https:\/\//);
      assert.ok(["brewery", "retailer", "community"].includes(s.kind));
      assert.ok(s.fields.length > 0);
    }
  }
});

test("additions: no usable ratings/IDs on records; two confirmed + one unresolved; no name aliases", () => {
  for (const e of additionsEntries) {
    for (const forbidden of ["rating", "rating_raw", "ratings_count", "untappd_id", "untappdId", "untappdScore", "ibu"]) {
      assert.equal((e as Record<string, unknown>)[forbidden], undefined, `${e.id} must not define ${forbidden}`);
    }
    assert.deepEqual(e.aliases, [], "no title aliases on photo rows (no wrong-variant aliasing)");
  }
  assert.equal(addByIndex.get(1)!.identity_status, "confirmed");
  assert.equal(addByIndex.get(10)!.identity_status, "confirmed");
  const arpus = addByIndex.get(16)!;
  assert.equal(arpus.identity_status, "version_unresolved");
  assert.equal(arpus.canonical_name, null);
  assert.equal(arpus.style, null);
  assert.equal(arpus.abv, null);
  // The Chinese photo poem is deliberately NOT an identity key.
  assert.equal(arpus.name_zh, "");
  // The full five-ingredient product must not be a confirmed alias.
  assert.ok(!arpus.aliases.some(a => /peanut/i.test(a)));
  assert.ok(!arpus.aliases.some(a => /pineapple/i.test(a)));
});

test("additions: exact transcribed/allowed name and brewery labels only", () => {
  const waldhaus = addByIndex.get(1)!;
  assert.equal(waldhaus.menu_name, "Spezial Gold");
  assert.equal(waldhaus.name_zh, "黄金特酿");
  assert.equal(waldhaus.brewery, "Waldhaus");
  assert.deepEqual(waldhaus.brewery_aliases, ["Brauerei Waldhaus", "Privatbrauerei Waldhaus"]);

  const cactus = addByIndex.get(10)!;
  assert.equal(cactus.menu_name, "Cactus");
  assert.equal(cactus.name_zh, "刺球");
  assert.equal(cactus.brewery, "Tilted Barn");
  assert.deepEqual(cactus.brewery_aliases, ["Tilted Barn Brewery"]);

  const arpus = addByIndex.get(16)!;
  assert.equal(arpus.menu_name, "Blackberry/Blueberry/mango");
  assert.equal(arpus.brewery, "Arpus");
  assert.deepEqual(arpus.brewery_aliases, []);
});

test("additions: per-row field/source coverage matches the context brief", () => {
  const waldhaus = addByIndex.get(1)!;
  assert.equal(waldhaus.sources.length, 1);
  assert.equal(waldhaus.sources[0].kind, "brewery");
  assert.equal(waldhaus.sources[0].url, "https://www.waldhaus-bier.de/en/beer-specialties/spezial-gold/");
  assert.ok(waldhaus.sources[0].fields.includes("ingredient_origins"));

  const cactus = addByIndex.get(10)!;
  const kinds = new Map(cactus.sources.map(s => [s.url, s]));
  assert.equal(kinds.get("https://untappd.com/v/tilted-barn-brewery/2296372")!.kind, "community");
  assert.equal(kinds.get("https://www.beeradvocate.com/beer/profile/37721/264713/")!.kind, "community");
  const official = kinds.get("https://www.tiltedbarnbrewery.com/beers-past-present-1")!;
  assert.equal(official.kind, "brewery");
  assert.ok(official.fields.some(f => f.startsWith("other_variant_")), "official page only documents the DDH variant");

  const arpus = addByIndex.get(16)!;
  assert.equal(arpus.sources.length, 1);
  assert.match(arpus.sources[0].url, /arpusbrewing\.co\/products\/blackberry/);
});

test("Arpus: can offer is preserved as candidate-only structured data, never a draft comparison", () => {
  const d = addByIndex.get(16)!.field_disagreements as Record<string, any>;
  assert.equal(d.identity.resolution, "version_unresolved_short_title_three_fruits_only");
  assert.equal(d.identity.menu_title, "Blackberry/Blueberry/mango");
  assert.match(d.identity.candidate, /Peanut Butter Smoothie Sour Ale/);
  const offer = d.candidate_offer;
  assert.equal(offer.price_eur_tax_included, 6.19);
  assert.equal(offer.volume_ml, 440);
  assert.equal(offer.fx_eur_cny, null);
  assert.equal(offer.scope, "candidate_only_never_compared_to_photographed_cny_draft");
  assert.match(offer.handling, /no savingsVsOrigin/);
});

// ── 2. Original 17-file observations stay the dated snapshot ──

test("original 17 file unchanged: dated 2026-10-20 observations, 2026-10-21 checks, old ids", () => {
  assert.equal(baseEntries.length, 17);
  assert.match(baseParsed.scope, /transcribed 2026-10-20/);
  for (const e of baseEntries) {
    assert.match(e.id, /^elnido-2026-10-(0[2-9]|1[0-8])$/);
    assert.equal(e.observation.observed_at, "2026-10-20");
    for (const s of e.sources) assert.equal(s.checked_at, "2026-10-21");
  }
});

// ── 3. Reader: fixed two-file combine, independently fail-soft ──

test("reader: real cwd combines 17 original + 3 additions = 20, originals first", async () => {
  const cwd = process.cwd();
  try {
    process.chdir(repoRoot);
    const loaded = await readMenuSupplements();
    assert.equal(loaded.length, 20);
    assert.deepEqual(loaded.slice(0, 17).map(e => e.id), baseEntries.map(e => e.id));
    assert.deepEqual(loaded.slice(17).map(e => e.id), additionsEntries.map(e => e.id));
  } finally {
    process.chdir(cwd);
  }
});

test("reader: each fixed file fails soft independently; no arbitrary discovery", async () => {
  const cwd = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), "elnido-additions-reader-"));
  const menusDir = path.join(dir, "data", "menus");
  const baseFile = path.join(menusDir, "elnido-2026-10.json");
  const additionsFile = path.join(menusDir, "elnido-2026-10-additions.json");
  try {
    await mkdir(menusDir, { recursive: true });
    process.chdir(dir);
    assert.deepEqual(await readMenuSupplements(), [], "both missing -> []");

    await writeFile(additionsFile, additionsRaw, "utf8");
    const onlyAdditions = await readMenuSupplements();
    assert.equal(onlyAdditions.length, 3, "missing original never blocks additions");

    await writeFile(baseFile, "{ broken", "utf8");
    const brokenBase = await readMenuSupplements();
    assert.equal(brokenBase.length, 3, "malformed original ignored independently");

    await writeFile(additionsFile, "[1,2,3]", "utf8");
    const brokenAdditions = await readMenuSupplements();
    assert.deepEqual(brokenAdditions, [], "non-object additions -> [] and broken base still []");

    await writeFile(baseFile, JSON.stringify(baseParsed), "utf8");
    await writeFile(additionsFile, additionsRaw, "utf8");
    const both = await readMenuSupplements();
    assert.equal(both.length, 20);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. Confirmed addition: Waldhaus Spezial Gold ──

test("tap1 Spezial Gold / Waldhaus grounds confirmed with canonical 5.6% Lager and stripped scores", () => {
  const stale = candidate({
    displayName: "Spezial Gold",
    brewery: "Waldhaus",
    abv: 0,
    style: "",
    menuIndex: 1,
    price: 70,
    volumeMl: 425,
    currency: "CNY",
    untappdId: "999",
    untappdScore: 3.8,
    untappdRatingCount: 500,
    untappdUrl: "https://untappd.com/b/xxx/999",
    labelImage: "https://img.example/spezial.jpg",
    valueScore: 60,
    originBenchmark: 50,
    savingsVsOrigin: 10,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu: Spezial Gold 5.6" }, ocrMenuAbvEvidence(5.6)],
  });
  const out = groundOne(stale);
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-additions-01");
  assert.equal(out.abv, 5.6);
  assert.equal(out.style, "Lager");
  assert.equal(out.untappdId, null);
  assert.equal(out.untappdScore, null);
  assert.equal(out.untappdRatingCount, null);
  assert.equal(out.untappdUrl, null);
  assert.equal(out.labelImage, null);
  assert.equal(out.valueScore, null);
  assert.equal(out.originBenchmark, null);
  assert.equal(out.savingsVsOrigin, null);
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_NO_RATING));
  assert.equal(out.price, 70, "photo OCR price preserved on the candidate");
  assert.equal(out.volumeMl, 425);

  const text = socialText(out);
  assert.match(text, /未标日期用户照片转录行/);
  assert.match(text, /2026-10-24/);
  assert.match(text, /waldhaus-bier\.de/);
  // Distinct from the old dated snapshot.
  assert.match(text, /独立于 2026-10-20 快照/);
  // Photo price/volume never enter evidence.
  assert.doesNotMatch(text, /¥|CNY\s*\d|\b70\b|\b425\s*ml/i);
  // Limitation framings survive.
  assert.match(text, /产地/);
  assert.match(text, /品种/);
  assert.match(text, /Bitterunits 4/);
  assert.match(text, /不是 IBU/);
  assert.match(text, /不得表述为旗舰款或最畅销/);
  assert.match(text, /零售价格/);
});

test("Waldhaus: both exact brewery aliases and the Chinese photo name ground; wrong brewery refuses", () => {
  for (const brewery of ["Waldhaus", "Brauerei Waldhaus", "Privatbrauerei Waldhaus"]) {
    const out = groundOne(candidate({ displayName: "Spezial Gold", brewery, abv: 5.6 }));
    assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-additions-01", brewery);
  }
  const zh = groundOne(candidate({ displayName: "黄金特酿", brewery: "Waldhaus" }));
  assert.equal(getSupplementGrounding(zh)?.entryId, "elnido-2026-10-additions-01");

  const wrong = candidate({ displayName: "Spezial Gold", brewery: "Some Other Haus", abv: 5.6 });
  assert.equal(groundOne(wrong), wrong);
  assert.equal(getSupplementGrounding(wrong), null);
});

// ── 5. Confirmed addition: Tilted Barn Cactus (variant-safe) ──

test("tap10 Cactus / Tilted Barn grounds confirmed at 7.8% with community/venue provenance", () => {
  const out = groundOne(candidate({
    displayName: "Cactus",
    brewery: "Tilted Barn",
    menuIndex: 10,
    price: 65,
    volumeMl: 300,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu Cactus 7.8" }, ocrMenuAbvEvidence(7.8)],
  }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-additions-10");
  assert.equal(out.abv, 7.8);
  assert.match(out.style, /Hazy IPA/);
  const text = socialText(out);
  assert.match(text, /untappd\.com\/v\/tilted-barn-brewery\/2296372/);
  assert.match(text, /beeradvocate\.com\/beer\/profile\/37721\/264713/);
  assert.match(text, /tiltedbarnbrewery\.com\/beers-past-present-1/);
  assert.match(text, /70 IBU/);
  assert.match(text, /页面显示值/);
  assert.match(text, /菠萝/);
  assert.match(text, /芒果/);
  assert.match(text, /番石榴/);
  assert.match(text, /社区条目所列/);
  // Variant/process-transfer guards.
  assert.match(text, /DDH Cactus/);
  assert.match(text, /另一变体/);
  assert.match(text, /Amarillo\/Citra\/El Dorado\/Mosaic 酒花清单不适用/);
  assert.match(text, /Bissell/);
  // No photo price leak (70 IBU is the only 70 allowed).
  assert.doesNotMatch(text, /¥|CNY\s*\d|\b65\b|\b300\s*ml/i);
});

test("Cactus: name-only candidate still uniquely resolves; full brewery alias works", () => {
  const noBrewery = groundOne(candidate({ displayName: "Cactus" }));
  assert.equal(getSupplementGrounding(noBrewery)?.entryId, "elnido-2026-10-additions-10");
  const full = groundOne(candidate({ displayName: "Cactus", brewery: "Tilted Barn Brewery" }));
  assert.equal(getSupplementGrounding(full)?.entryId, "elnido-2026-10-additions-10");
  const zh = groundOne(candidate({ displayName: "刺球", brewery: "Tilted Barn" }));
  assert.equal(getSupplementGrounding(zh)?.entryId, "elnido-2026-10-additions-10");
});

test("Cactus negatives: DDH Cactus variant, Bissell collab brewery and wrong brewery never ground", () => {
  const negatives: Array<[string, string]> = [
    ["DDH Cactus", "Tilted Barn"],          // different variant, no alias transfer
    ["Cactus", "Bissell Brothers"],         // collab is a different beer
    ["Cactus", "Bissell"],                  // collab brewery short label
    ["DDH Cactus", "Tilted Barn Brewery"],
    ["刺球", "Other Brewery"],               // right name, wrong brewery
  ];
  for (const [displayName, brewery] of negatives) {
    const input = candidate({ displayName, brewery, abv: 7.8 });
    const out = groundOne(input);
    assert.equal(out, input, `${displayName} / ${brewery} must stay unmatched`);
    assert.equal(getSupplementGrounding(out), null);
  }
});

// ── 6. Unresolved addition: Arpus short title ──

function arpusCandidate(over: Record<string, unknown> = {}) {
  return candidate({
    displayName: "Blackberry/Blueberry/mango",
    brewery: "Arpus",
    menuIndex: 16,
    abv: 4.5,
    price: 80,
    volumeMl: 300,
    currency: "CNY",
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu: Blackberry/Blueberry/mango 4.5 Smoothie Sour" },
      ocrMenuAbvEvidence(4.5),
      ocrMenuStyleEvidence("Smoothie Sour"),
    ],
    ...over,
  });
}

test("Arpus: short title grounds as version_unresolved, OCR 4.5/style kept, scores stripped", () => {
  const stale = arpusCandidate({
    untappdId: "123",
    untappdScore: 4.3,
    untappdRatingCount: 99,
    labelImage: "https://img.example/arpus.jpg",
    valueScore: 70,
    originBenchmark: 90,
    savingsVsOrigin: -20,
  });
  const out = groundOne(stale);
  const g = getSupplementGrounding(out);
  assert.equal(g?.entryId, "elnido-2026-10-additions-16");
  assert.equal(g?.identityStatus, "version_unresolved");
  assert.equal(out.abv, 4.5, "OCR observation retained verbatim");
  assert.equal(out.style, "Smoothie Sour", "OCR style retained via explicit marker only");
  assert.equal(out.untappdId, null);
  assert.equal(out.untappdScore, null);
  assert.equal(out.untappdRatingCount, null);
  assert.equal(out.labelImage, null);
  assert.equal(out.valueScore, null);
  assert.equal(out.originBenchmark, null, "can offer never becomes an origin benchmark");
  assert.equal(out.savingsVsOrigin, null, "no bar-vs-can savings ever");
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_VERSION_UNRESOLVED));
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_NO_RATING));
});

test("Arpus evidence: full title is a candidate only; peanut butter unconfirmed; can offer never rendered", () => {
  const out = groundOne(arpusCandidate());
  const text = socialText(out);
  assert.match(text, /未标日期用户照片转录行/);
  assert.match(text, /身份未定/);
  assert.match(text, /可能候选?.*Blackberry x Blueberry x Mango x Pineapple x Peanut Butter Smoothie Sour Ale/);
  assert.match(text, /花生酱/);
  assert.match(text, /未确认/);
  assert.match(text, /完整产品名未注册为短标题的确认别名|未注册为短标题的确认别名/);
  assert.match(text, /不与照片中的酒吧生啤比价/);
  // The actual EUR can offer lives only in structured data / the audit doc.
  assert.doesNotMatch(text, /EUR|€|6\.19|0\.44|\b440\b/);
  // Photo price stays out of evidence.
  assert.doesNotMatch(text, /¥|\b80\s*CNY|\b80\s*元|\b300\s*ml/i);
});

test("Arpus negatives: full product title, Chinese poem, wrong/unknown brewery never match", () => {
  const fullTitle = "Blackberry x Blueberry x Mango x Pineapple x Peanut Butter Smoothie Sour Ale";
  const negatives: Array<[string, string]> = [
    [fullTitle, "Arpus"],                        // candidate is NOT an alias of the photo row
    [fullTitle, "Arpus Brewing"],               // and not via an invented brewery alias
    ["花落花间影亦花", "Arpus"],                   // Chinese photo title is not an identity key
    ["Blackberry/Blueberry/mango", "Other Co"], // right short title, wrong brewery
    ["Blackberry Blueberry Mango Smoothie", "Arpus"], // extra word -> a different product
  ];
  for (const [displayName, brewery] of negatives) {
    const input = candidate({ displayName, brewery, abv: 4.5 });
    const out = groundOne(input);
    assert.equal(out, input, `${displayName} / ${brewery} must stay unresolved`);
    assert.equal(getSupplementGrounding(out), null);
  }
});

test("Arpus: legacy-only ABV/style (no OCR markers) clears to unknown even with inherited score", () => {
  const legacy = arpusCandidate({
    abv: 4.5,
    style: "Smoothie Sour",
    untappdScore: 4.3,
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu row" },
      { source: "untappd", confidence: 0.9, summary: "本地 beer_cache 酒款记录：Arpus / short title，评分 4.3，99 次评分" },
    ],
  });
  const out = groundOne(legacy);
  assert.equal(getSupplementGrounding(out)?.identityStatus, "version_unresolved");
  assert.equal(out.abv, 0, "no explicit OCR ABV channel -> unknown, never the can product's value by inheritance");
  assert.equal(out.style, "");
  assert.equal(out.untappdScore, null);
  assert.ok(!out.evidence.some(e => e.source === "untappd"), "stale per-beer rating evidence pruned");
  assert.doesNotMatch(socialText(out), /0%/);
});

// ── 7. Tap is never identity: same-number old/new rows stay distinct in the combined 20 ──

test("tap independence: same menuIndex never aliases old rows to additions or vice versa", () => {
  const cases: Array<[string, string, number, string]> = [
    ["Green Reaper", "Shred", 10, "elnido-2026-10-10"],
    ["Cactus", "Tilted Barn", 16, "elnido-2026-10-additions-10"],
    ["Grandma's Feijoa", "Big Pot", 1, "elnido-2026-10-16"],
    ["Blackberry/Blueberry/mango", "Arpus", 11, "elnido-2026-10-additions-16"],
    ["Spezial Gold", "Waldhaus", 18, "elnido-2026-10-additions-01"],
    ["Windy Hill", "Mikkeller", 1, "elnido-2026-10-02"],
    ["K-philia", "Totopia", 16, "elnido-2026-10-11"],
  ];
  for (const [displayName, brewery, menuIndex, expectedId] of cases) {
    const out = groundOne(candidate({ displayName, brewery, menuIndex }));
    assert.equal(getSupplementGrounding(out)?.entryId, expectedId, `${displayName} @tap${menuIndex}`);
  }

  // An unknown name sitting on a photo tap stays unmatched.
  const mystery = candidate({ displayName: "Mystery Pour", brewery: "Arpus", menuIndex: 16 });
  assert.equal(groundOne(mystery), mystery);
});

test("all 20 combined rows ground by their own exact menu_name + brewery; old gates still hold", () => {
  for (const e of combined) {
    const out = groundOne(candidate({ displayName: e.menu_name, brewery: e.brewery, abv: e.observation.abv ?? 0 }));
    assert.equal(getSupplementGrounding(out)?.entryId, e.id, `${e.brewery} / ${e.menu_name}`);
  }
  // Old unresolved row keeps its flag through the combined set.
  const k = groundOne(candidate({ displayName: "K-philia", brewery: "Totopia" }));
  assert.equal(getSupplementGrounding(k)?.identityStatus, "version_unresolved");
});

// ── 8. Knowledge-context integration + hard constraint gates ──

function memoryFor(candidates: ReturnType<typeof candidate>[]) {
  return {
    lastMenu: { traceId: "trace-add", source: "ocr", createdAt: "2026-10-24T11:00:00Z", candidates },
    activeBeer: null,
  };
}

test("integration: grounded photo rows render through buildMenuPromptSection with provenance and no can price", () => {
  const waldhaus = groundOne(candidate({
    candidateId: "ocr_1", menuIndex: 1, displayName: "Spezial Gold", brewery: "Waldhaus",
    abv: 5.6, price: 70, volumeMl: 425, currency: "CNY",
    evidence: [{ source: "ocr", confidence: 0.9, summary: "#1 Spezial Gold" }, ocrMenuAbvEvidence(5.6)],
  }));
  const arpus = groundOne(arpusCandidate({ candidateId: "ocr_16" }));
  const section = buildMenuPromptSection(memoryFor([waldhaus, arpus]), "#16 是什么");
  assert.match(section, /\[来源:social_web\]/);
  assert.match(section, /ABV 4\.5%/);
  assert.match(section, /未标日期用户照片转录行/);
  assert.match(section, /版本未确认|版本待确认|身份未定/);
  assert.match(section, /花生酱/);
  assert.match(section, /未确认/);
  assert.doesNotMatch(section, /EUR|€|6\.19|0\.44/);
  // Current photo OCR economics may render on the roster, but premium/savings
  // appear ONLY as an explicit never-computed negation — never a positive claim.
  assert.match(section, /不计算酒吧溢价/);
  assert.match(section, /不产生 savingsVsOrigin/);
  assert.doesNotMatch(section, /便宜/);

  const wSection = buildMenuPromptSection(memoryFor([waldhaus]), "#1");
  assert.match(wSection, /ABV 5\.6%/);
  assert.match(wSection, /Lager/);
});

test("integration: hard ABV gates unchanged for the new confirmed/unresolved rows", () => {
  const max9 = extractConstraints("酒精度不超过9%");
  assert.ok(max9.includes("maxAbv:9"));

  const cactus = groundOne(candidate({
    displayName: "Cactus", brewery: "Tilted Barn", abv: 7.8,
    evidence: [ocrMenuAbvEvidence(7.8)],
  }));
  assert.deepEqual(constraintFailures(cactus, max9), [], "clean 7.8% confirmed passes maxAbv:9");

  const arpusOcr = groundOne(arpusCandidate());
  assert.deepEqual(constraintFailures(arpusOcr, max9), [], "OCR-observed 4.5% passes maxAbv:9");

  const arpusLegacy = groundOne(candidate({
    displayName: "Blackberry/Blueberry/mango", brewery: "Arpus", abv: 4.5,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu row" }],
  }));
  assert.equal(arpusLegacy.abv, 0);
  assert.ok(constraintFailures(arpusLegacy, max9).some(f => /酒精度未知/.test(f)));

  // 5.6 confirmed over a tighter cap fails numerically, not via a false conflict.
  const waldhaus = groundOne(candidate({
    displayName: "Spezial Gold", brewery: "Waldhaus", abv: 5.6,
    evidence: [ocrMenuAbvEvidence(5.6)],
  }));
  const max5 = extractConstraints("酒精度不超过5%");
  assert.ok(constraintFailures(waldhaus, max5).some(f => /酒精度不符合要求/.test(f)));
  assert.ok(!constraintFailures(waldhaus, max5).some(f => /冲突/.test(f)));
});

// ── 9. Source-audit document ──

test("source-audit doc: fields, sources, dates, limitations and non-comparability documented", async () => {
  const doc = await readFile(new URL("../docs/data/2026-10-24-menu-source-audit.md", import.meta.url), "utf8");
  assert.match(doc, /2026-10-24/);
  assert.match(doc, /undated-user-photo|未标日期/);
  assert.match(doc, /2026-10-20/);
  assert.match(doc, /waldhaus-bier\.de\/en\/beer-specialties\/spezial-gold/);
  assert.match(doc, /untappd\.com\/v\/tilted-barn-brewery\/2296372/);
  assert.match(doc, /beeradvocate\.com\/beer\/profile\/37721\/264713/);
  assert.match(doc, /tiltedbarnbrewery\.com\/beers-past-present-1/);
  assert.match(doc, /arpusbrewing\.co\/products\/blackberry/);
  assert.match(doc, /5\.60?%/);
  assert.match(doc, /7\.8%/);
  assert.match(doc, /Bitterunits/);
  assert.match(doc, /70 IBU/);
  assert.match(doc, /DDH Cactus/);
  assert.match(doc, /Bissell/);
  assert.match(doc, /花生酱/);
  assert.match(doc, /6\.19/);
  assert.match(doc, /0\.44|440\s?ml/i);
  assert.match(doc, /不.{0,12}(比较|比价)|never compared/i);
  assert.match(doc, /savingsVsOrigin/);
});
