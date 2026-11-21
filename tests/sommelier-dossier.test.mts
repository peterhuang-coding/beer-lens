import test from "node:test";
import assert from "node:assert/strict";
import { recommendFromCandidates } from "../lib/beer-agent/recommendation/decision.ts";
import { calcValueScore } from "../lib/beer-agent/beer-db/value-calc.ts";
import { readMenuSupplements } from "../lib/beer-agent/menu-supplements.ts";
import type { BeerCandidate } from "../lib/beer-agent/types.ts";
import { buildMenuPromptSection } from "../lib/skills/beer-knowledge/menu-context.ts";

async function dossierModule() {
  return import("../lib/beer-agent/dossier/build-dossier.ts");
}

function candidate(overrides: Record<string, unknown> = {}): BeerCandidate {
  return {
    candidateId: "ocr_1",
    menuIndex: 1,
    displayName: "Test Beer",
    brewery: "Test Brewery",
    style: "Dubbel",
    abv: 7,
    ibu: null,
    hops: [],
    worthScore: 50,
    fitScore: 50,
    riskFlags: [],
    reason: "",
    evidence: [{
      source: "ocr",
      confidence: 0.9,
      summary: "菜单转录明示 ABV 7%；菜单转录明示风格 Dubbel（菜单转录观察，风格以公开来源核对为准）",
    }],
    price: 60,
    volumeMl: 300,
    currency: "CNY",
    ...overrides,
  } as BeerCandidate;
}

function supplement(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-entry",
    menu_index: 1,
    menu_name: "Test Beer",
    name_zh: "",
    brewery: "Test Brewery",
    brewery_aliases: [],
    aliases: [],
    identity_status: "confirmed",
    canonical_name: "Test Beer",
    style: "Dubbel",
    abv: 7,
    description_zh: "synthetic public-source record",
    observation: {
      abv: 7,
      price: 60,
      volume_ml: 300,
      currency: "CNY",
      observed_at: "2026-10-20",
      source: "menu_transcription",
    },
    sources: [{
      url: "https://example.com/beer",
      kind: "brewery",
      access: "web_index_or_cache",
      checked_at: "2026-10-21",
      fields: ["identity", "style", "abv", "hops", "flavor_notes", "process"],
    }],
    issues: [],
    field_disagreements: {},
    ...overrides,
  } as any;
}

function groundedCandidate(entry: any, overrides: Record<string, unknown> = {}) {
  const merged = candidate(overrides);
  const observations = [];
  if (merged.abv > 0) {
    observations.push({ source: "ocr" as const, confidence: 0.9, summary: `菜单转录明示 ABV ${merged.abv}%（菜单转录观察值，以公开来源核对为准）` });
  }
  if (merged.style.trim()) {
    observations.push({ source: "ocr" as const, confidence: 0.9, summary: `菜单转录明示风格 ${merged.style}（菜单转录观察，风格以公开来源核对为准）` });
  }
  return {
    ...merged,
    evidence: [
      ...observations,
      {
        source: "social_web" as const,
        confidence: 0.85,
        summary: `[menu_id:test-menu] [menu_supplement:${entry.id}] [identity_status:${entry.identity_status}]`,
      },
    ],
  };
}

test("OCR-only beer gets a labeled style layer, never product hops or ingredients", async () => {
  const { buildBeerDossier } = await dossierModule();
  const dossier = buildBeerDossier(candidate(), []);
  assert.equal(dossier.hops, null);
  assert.equal(dossier.ingredients, null);
  assert.equal(dossier.styleLayer.source, "style_inference");
  assert.match(dossier.styleLayer.label, /风格通性/);
  assert.match(dossier.styleLayer.summary, /麦芽|焦糖|深色水果/);
  assert.equal(dossier.coverage.hops, "unknown");
  assert.equal(dossier.coverage.sensory, "style_inference");
  assert.equal(dossier.identity.identityStatus, "unmatched");
});

test("OCR-only Kölsch gets style education instead of an empty style layer", async () => {
  const { buildBeerDossier } = await dossierModule();
  const dossier = buildBeerDossier(candidate({
    style: "Kölsch",
    abv: 4.8,
    evidence: [{
      source: "ocr",
      confidence: 0.9,
      summary: "菜单转录明示 ABV 4.8%；菜单转录明示风格 Kölsch（菜单转录观察，风格以公开来源核对为准）",
    }],
  }), []);
  assert.equal(dossier.styleLayer.style, "Kölsch");
  assert.match(dossier.styleLayer.summary, /清爽|干爽/);
  assert.equal(dossier.coverage.sensory, "style_inference");
});

test("structured facts retain field-level URL, access, excerpt and checked date", async () => {
  const { buildBeerDossier } = await dossierModule();
  const entry = supplement({
    sourced_facts: {
      hops: { values: ["Citra", "Nelson Sauvin"], sources: [0], excerpt: "Citra + Nelson" },
      sensory: { values: ["柑橘皮", "潮湿草本"], sources: [0], excerpt: "citrus and dank" },
      process: { values: ["双倍干投"], sources: [0], excerpt: "double dry hopped" },
    },
  });
  const dossier = buildBeerDossier(groundedCandidate(entry), [entry]);
  assert.deepEqual(dossier.hops.value, ["Citra", "Nelson Sauvin"]);
  assert.equal(dossier.hops.url, "https://example.com/beer");
  assert.equal(dossier.hops.checkedAt, "2026-10-21");
  assert.equal(dossier.hops.access, "web_index_or_cache");
  assert.equal(dossier.hops.excerpt, "Citra + Nelson");
  assert.deepEqual(dossier.process.value, ["双倍干投"]);
  assert.equal(dossier.coverage.hops, "sourced");
  assert.equal(dossier.coverage.sensory, "sourced");
});

test("a sourced fact with an invalid index or unsupported source field is rejected", async () => {
  const { buildBeerDossier } = await dossierModule();
  const badIndex = supplement({
    sourced_facts: { hops: { values: ["Citra"], sources: [4], excerpt: "bad" } },
  });
  const wrongField = supplement({
    sources: [{ ...supplement().sources[0], fields: ["identity"] }],
    sourced_facts: { hops: { values: ["Citra"], sources: [0], excerpt: "wrong" } },
  });
  assert.equal(buildBeerDossier(groundedCandidate(badIndex), [badIndex]).hops, null);
  assert.equal(buildBeerDossier(groundedCandidate(wrongField), [wrongField]).hops, null);
});

test("version/batch unresolved identity blocks exact product facts and undated ratings", async () => {
  const { buildBeerDossier } = await dossierModule();
  for (const identityStatus of ["version_unresolved", "batch_unresolved"]) {
    const entry = supplement({
      identity_status: identityStatus,
      style: "West Coast Triple IPA",
      abv: 9.5,
      sourced_facts: { hops: { values: ["Citra"], sources: [0], excerpt: "candidate only" } },
    });
    const dossier = buildBeerDossier(groundedCandidate(entry, {
      style: "",
      abv: 7,
      untappdScore: 4.9,
      untappdRatingCount: 999,
      untappdUrl: "https://example.com/rating",
      ratingCheckedAt: "2026-10-21",
    }), [entry]);
    assert.equal(dossier.hops, null);
    assert.equal(dossier.rating, null);
    assert.equal(dossier.style, null);
    assert.equal(dossier.identity.identityStatus, identityStatus);
    assert.deepEqual(dossier.abv.observations.map((claim: any) => claim.value), [7]);
    assert.equal(dossier.abv.observations[0].source, "ocr");
  }
});

test("ABV conflict remains parallel; explained one-decimal display is not a conflict", async () => {
  const { buildBeerDossier } = await dossierModule();
  const conflict = supplement({
    abv: 9.1,
    field_disagreements: { abv: { brewery_order_page: 9.1, systembolaget: 9, menu_observation: 9 } },
    sources: [
      { ...supplement().sources[0], fields: ["abv"] },
      { ...supplement().sources[0], url: "https://example.com/retailer", kind: "retailer", fields: ["abv"] },
    ],
  });
  const conflicted = buildBeerDossier(groundedCandidate(conflict, { abv: 9 }), [conflict]);
  assert.equal(conflicted.abv.conflicted, true);
  assert.deepEqual([...new Set(conflicted.abv.observations.map((claim: any) => claim.value))].sort(), [9, 9.1]);

  const rounding = supplement({
    abv: 19.25,
    field_disagreements: { abv: { source_exact: 19.25, menu_observation: 19.2, resolution: "one_decimal_rounding" } },
  });
  const rounded = buildBeerDossier(groundedCandidate(rounding, { abv: 19.25 }), [rounding]);
  assert.equal(rounded.abv.conflicted, false);
  assert.equal(rounded.abv.resolution, "one_decimal_rounding");
});

test("rating needs score, integer count, source URL and snapshot date; high score never proves flagship", async () => {
  const { buildBeerDossier } = await dossierModule();
  const base = {
    style: "Hazy IPA",
    untappdScore: 4.9,
    untappdRatingCount: 999,
    untappdUrl: "https://example.com/rating",
  };
  assert.equal(buildBeerDossier(candidate(base), []).rating, null);
  const dossier = buildBeerDossier(candidate({ ...base, ratingCheckedAt: "2026-10-21" }), []);
  assert.deepEqual(dossier.rating.value, { score: 4.9, count: 999 });
  assert.equal(dossier.rating.checkedAt, "2026-10-21");
  assert.equal(dossier.brewery.flagship.status, "unproven");
  assert.equal(dossier.brewery.flagship.beer, null);
});

test("producer classic wording stays a classic claim, not flagship or bestseller evidence", async () => {
  const { buildBeerDossier } = await dossierModule();
  const entry = supplement({
    sourced_facts: {
      reputation: {
        values: [{ kind: "classic", text: "酒厂自述：创始人年代延续至今的经典老款；不等于旗舰或最畅销" }],
        sources: [0],
        excerpt: "a classic from our founding era",
      },
    },
    sources: [{ ...supplement().sources[0], fields: ["producer_description"] }],
  });
  const dossier = buildBeerDossier(groundedCandidate(entry), [entry]);
  assert.equal(dossier.brewery.reputation[0].value.kind, "classic");
  assert.equal(dossier.brewery.flagship.status, "unproven");
  assert.match(dossier.brewery.reputation[0].value.text, /不等于旗舰/);
});

test("curated试点资料提供结构化酒花；无款级感官时仍保留风格通性", async () => {
  const { buildBeerDossier } = await dossierModule();
  const entries = await readMenuSupplements();
  const byName = (name: string) => entries.find(entry => entry.menu_name === name)!;
  const kiwiEntry = byName("Kiwi Fingers");
  const kiwi = buildBeerDossier(groundedCandidate(kiwiEntry, { style: kiwiEntry.style, abv: kiwiEntry.abv }), entries);
  assert.deepEqual(kiwi.hops.value, ["Citra", "Nelson Sauvin"]);
  assert.equal(kiwi.hops.checkedAt, "2026-10-21");
  assert.equal(kiwi.coverage.sensory, "sourced");

  const victoryEntry = byName("Victory Lap");
  const victory = buildBeerDossier(groundedCandidate(victoryEntry, { style: victoryEntry.style, abv: victoryEntry.abv }), entries);
  assert.equal(victory.sensory, null);
  assert.match(victory.styleLayer.summary, /干爽|柑橘|松脂/);
  assert.equal(victory.coverage.sensory, "style_inference");

  const freeEntry = byName("Free Lunch");
  const free = buildBeerDossier(groundedCandidate(freeEntry, { style: freeEntry.style, abv: freeEntry.abv }), entries);
  assert.deepEqual(free.hops.value, ["Citra", "Strata", "Mosaic", "Nelson Sauvin", "Krush"]);
  assert.equal(free.brewery.flagship.status, "unproven");
});

test("initial-menu reply covers every row with useful labeled knowledge and at most three picks", () => {
  const styles = ["Dubbel", "West Coast IPA", "Hazy IPA", "German Pilsner", "Best Bitter", "Smoothie Sour", "Imperial Stout", "Saison", "Wheat Beer", "Gose"];
  const rows = styles.map((style, index) => candidate({
    candidateId: `row_${index + 1}`,
    menuIndex: index + 1,
    displayName: `Menu Beer ${index + 1}`,
    style,
    abv: 4.5 + index * 0.5,
    price: 40 + index * 5,
  }));
  const result = recommendFromCandidates(rows, null, [], false, "", { initialMenu: true } as any);
  assert.match(result.reply, /整单解读/);
  assert.match(result.reply, /共 10 款/);
  for (let index = 0; index < rows.length; index++) {
    assert.match(result.reply, new RegExp(`#${index + 1} .*Menu Beer ${index + 1}`));
  }
  assert.match(result.reply, /风格通性，非本款事实/);
  assert.match(result.reply, /品饮顺序/);
  assert.ok(!result.reply.includes("比原产国"));
  const pickSection = result.reply.split("整单解读")[0];
  assert.ok((pickSection.match(/^\d+\. /gm) ?? []).length <= 3);
});

test("knowledge context preserves dossier provenance and separates classic from flagship", async () => {
  const { buildBeerDossier } = await dossierModule();
  const entry = supplement({
    sources: [{
      ...supplement().sources[0],
      fields: ["identity", "style", "abv", "hops", "flavor_notes", "process", "producer_description"],
    }],
    sourced_facts: {
      hops: { values: ["Citra", "Nelson Sauvin"], sources: [0], excerpt: "Citra + Nelson" },
      process: { values: ["双倍干投"], sources: [0], excerpt: "double dry hopped" },
      reputation: {
        values: [{ kind: "classic", text: "酒厂自述经典老款；不等于旗舰或最畅销" }],
        sources: [0],
      },
    },
  });
  const grounded = groundedCandidate(entry);
  const dossier = buildBeerDossier(grounded, [entry]);
  const section = buildMenuPromptSection({
    lastMenu: { source: "text", createdAt: "2026-10-22T00:00:00Z", candidates: [{ ...grounded, dossier }] },
  }, "Test Beer 的酒花和经典地位");
  assert.match(section, /款级酒花.*Citra、Nelson Sauvin/);
  assert.match(section, /https:\/\/example\.com\/beer/);
  assert.match(section, /web_index_or_cache/);
  assert.match(section, /2026-10-21/);
  assert.match(section, /Citra \+ Nelson/);
  assert.match(section, /款级工艺.*双倍干投/);
  assert.match(section, /酒厂自述经典老款/);
  assert.match(section, /旗舰.*未证实|旗舰.*未证明/);
  assert.match(section, /风格通性，非本款事实/);
  assert.match(section, /高分.*旗舰|评分.*旗舰/);
});

test("knowledge context labels an undated legacy rating as unverified", () => {
  const legacy = candidate({
    untappdScore: 4.2,
    untappdRatingCount: 88,
    untappdUrl: "https://example.com/legacy",
  });
  const section = buildMenuPromptSection({ lastMenu: { candidates: [legacy] } }, "Test Beer 评分");
  assert.match(section, /4\.2/);
  assert.match(section, /无可靠快照日期/);
  assert.match(section, /未核实/);
});

test("country constants never create an origin-price premium or discount", () => {
  for (const breweryCountry of [null, "US", "JP", "not-a-country"]) {
    const result = calcValueScore({ price: 66, volumeMl: 330, ratingScore: null, style: "IPA", abv: 6.5, breweryCountry });
    assert.equal(result.pricePer100ml, 20);
    assert.equal(result.valueScore, null);
    assert.equal(result.originBenchmark, null);
    assert.equal(result.originPricePer100ml, null);
    assert.equal(result.savingsVsOrigin, null);
    assert.equal(result.pricingBasis, null);
  }
});
