// Cross-module integration regressions for the El Nido curated supplement.
//
// These tests wire the actual delivered helpers together (no mocks):
//   - groundMenuSupplements  (lib/beer-agent/menu-supplements.ts)
//   - extractConstraints / constraintFailures (recommendation/constraints.ts)
//   - buildMenuPromptSection (skills/beer-knowledge/menu-context.ts)
//
// Public/synthetic data only; no model/DB/network.
// Run:
//   node --experimental-strip-types --test tests/menu-supplement-integration.test.mts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  groundMenuSupplements,
  getSupplementGrounding,
  ocrMenuAbvEvidence,
  ocrMenuStyleEvidence,
  RISK_SUPPLEMENT_ABV_CONFLICT,
  RISK_SUPPLEMENT_VERSION_UNRESOLVED,
  RISK_SUPPLEMENT_BATCH_UNRESOLVED,
  type MenuSupplementEntry,
} from "../lib/beer-agent/menu-supplements.ts";
import { extractConstraints, constraintFailures } from "../lib/beer-agent/recommendation/constraints.ts";
import { buildMenuPromptSection } from "../lib/skills/beer-knowledge/menu-context.ts";

const realRaw = await readFile(
  new URL("../data/menus/elnido-2026-10.json", import.meta.url),
  "utf8",
);
const realEntries: MenuSupplementEntry[] = JSON.parse(realRaw).entries;
const byIndex = new Map(realEntries.map(e => [e.menu_index, e]));

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

function groundOne(c: ReturnType<typeof candidate>): ReturnType<typeof candidate> {
  return groundMenuSupplements([c], realEntries)[0];
}

function memoryFor(c: ReturnType<typeof candidate>) {
  return {
    lastMenu: { traceId: "trace-int", source: "ocr", createdAt: "2026-10-21T09:00:00Z", candidates: [c] },
    activeBeer: null,
  };
}

// ── Finding 1: supplement ABV-conflict flag is interoperable with the real hard-constraint filter ──

test("finding 1: #15 unresolved 9-vs-9.1 conflict fails a real maxAbv:9 hard constraint", () => {
  const constraints = extractConstraints("酒精度不超过9%");
  assert.ok(constraints.includes("maxAbv:9"), `real parser must yield maxAbv:9, got ${constraints.join(",")}`);
  // The delivered flag wording must trip the constraints helper's own scan.
  assert.match(RISK_SUPPLEMENT_ABV_CONFLICT, /ABV.*(?:不一致|冲突)|abv_database_disagreement/i);

  const out = groundOne(candidate({
    displayName: "Double Blueberry Marshmallow Shake",
    brewery: "Great Notion",
    abv: 9,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 9%" }, ocrMenuAbvEvidence(9)],
  }));
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_ABV_CONFLICT));
  const failures = constraintFailures(out, constraints);
  assert.ok(
    failures.some(f => /酒精度来源有冲突/.test(f)),
    `unresolved 9 vs 9.1 must fail maxAbv:9 via the conflict channel, got: ${failures.join(" | ")}`,
  );
});

test("finding 1 controls: in-bound clean beer passes; over-limit numeric fail and #5 source conflict still fire", () => {
  // #2 Windy Hill 7%, hops-only disagreement: no ABV conflict, within limit.
  const windy = groundOne(candidate({
    displayName: "Windy Hill",
    brewery: "Mikkeller",
    abv: 7,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 7%" }, ocrMenuAbvEvidence(7)],
  }));
  assert.deepEqual(constraintFailures(windy, extractConstraints("酒精度不超过9%")), []);

  // Hard filter not weakened: stale 8.2 without OCR claim becomes canonical
  // 10.1 (#12 Free Lunch, rating-only disagreement) -> numeric failure.
  const freeLunch = groundOne(candidate({ displayName: "Free Lunch", brewery: "BlackStack", abv: 8.2 }));
  assert.equal(freeLunch.abv, 10.1);
  assert.ok(constraintFailures(freeLunch, ["maxAbv:9"]).some(f => /酒精度不符合要求/.test(f)));

  // #5 Good Idea 5% with a real 5-vs-4.9 source conflict: conflict beats the
  // numeric pass even though 5 <= 9.
  const goodIdea = groundOne(candidate({
    displayName: "Good Idea",
    brewery: "Ology",
    abv: 5,
    evidence: [ocrMenuAbvEvidence(5)],
  }));
  assert.ok(constraintFailures(goodIdea, ["maxAbv:9"]).some(f => /酒精度来源有冲突/.test(f)));
});

// ── Finding 2: unresolved rows are OCR-only through the actual knowledge context ──

test("finding 2: legacy-only unresolved K-philia renders unknown ABV/style, never 0% or the old 8.5", () => {
  const stale = groundOne(candidate({
    candidateId: "ocr_11",
    menuIndex: 11,
    displayName: "K-philia",
    brewery: "Totopia",
    abv: 8.5,
    style: "Imperial Oat Cream IPA",
    untappdId: "6063476",
    untappdScore: 4.2,
    untappdRatingCount: 88,
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu: K-philia" },
      { source: "untappd", confidence: 0.9, summary: "本地 beer_cache 酒款记录：Totopia / K-philia，评分 4.2，88 次评分" },
    ],
  }));
  assert.equal(getSupplementGrounding(stale)?.identityStatus, "version_unresolved");
  assert.equal(stale.abv, 0);
  assert.equal(stale.style, "");
  assert.equal(stale.untappdScore, null);
  assert.ok(!stale.evidence.some(e => e.source === "untappd"));

  const section = buildMenuPromptSection(memoryFor(stale), "#11 多少度");
  assert.match(section, /ABV 未知/);
  assert.doesNotMatch(section, /0%/);
  assert.match(section, /风格 未知/);
  const currentBeerLine = section.split("\n").find(line => line.startsWith("- #11 ")) ?? "";
  assert.match(currentBeerLine, /ABV 未知/);
  assert.doesNotMatch(currentBeerLine, /8\.5%/);
  assert.match(section, /旧款 K-philia 是 8\.5%.*并非同一款/);

  // Explicit OCR observations flow through: value and OCR style retained.
  const ocr = groundOne(candidate({
    candidateId: "ocr_11",
    menuIndex: 11,
    displayName: "K-philia",
    brewery: "Totopia",
    abv: 8.5,
    style: "Imperial Oat Cream IPA",
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu: K-philia 9.5%" },
      ocrMenuAbvEvidence(9.5),
      ocrMenuStyleEvidence("DDH West Coast Triple IPA"),
    ],
  }));
  assert.equal(ocr.abv, 9.5);
  assert.equal(ocr.style, "DDH West Coast Triple IPA");
  const ocrSection = buildMenuPromptSection(memoryFor(ocr), "#11 多少度");
  assert.match(ocrSection, /ABV 9\.5%/);
});

test("finding 2: #17 batch-unresolved legacy ABV clears without OCR marker, keeps explicit 6% with it", () => {
  const stale = groundOne(candidate({
    displayName: "The Cut: Laroda Plum",
    brewery: "Casey",
    abv: 6,
    style: "American Wild Ale",
    untappdScore: 4.44,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu row" }],
  }));
  assert.ok(stale.riskFlags.includes(RISK_SUPPLEMENT_BATCH_UNRESOLVED));
  assert.equal(stale.abv, 0);
  assert.equal(stale.style, "");
  assert.doesNotMatch(buildMenuPromptSection(memoryFor(stale), "这款"), /0%/);

  const ocr = groundOne(candidate({
    displayName: "The Cut: Laroda Plum",
    brewery: "Casey",
    abv: 6,
    evidence: [ocrMenuAbvEvidence(6)],
  }));
  assert.equal(ocr.abv, 6);
  assert.ok(ocr.riskFlags.includes(RISK_SUPPLEMENT_BATCH_UNRESOLVED));
});

// ── Finding 3: no stale per-beer score reaches the knowledge skill ──

test("finding 3: stale Untappd 4.2 snippet/evidence is pruned; the rendered context has no per-beer score", () => {
  const grounded = groundOne(candidate({
    candidateId: "ocr_2",
    menuIndex: 2,
    displayName: "Windy Hill",
    brewery: "Mikkeller",
    abv: 0,
    style: "",
    untappdScore: 3.93,
    untappdRatingCount: 68496,
    labelImage: "https://img.example.com/windy.jpg",
    valueScore: 71,
    originBenchmark: 88,
    savingsVsOrigin: 12,
    price: 60,
    volumeMl: 300,
    currency: "CNY",
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "菜单 #2：Windy Hill / Mikkeller" },
      { source: "untappd", confidence: 0.9, summary: "已核验 Mikkeller / Windy Hill：4.2（68496 人评分） https://untappd.com/beer/111" },
      { source: "agent_inference", confidence: 0.5, summary: "酒厂背景（非本款评分）：Mikkeller 库内 42 款均分 3.8；本款评分未知。" },
    ],
  }));
  assert.equal(grounded.untappdScore, null);
  assert.equal(grounded.labelImage, null);
  assert.equal(grounded.valueScore, null);
  assert.ok(!grounded.evidence.some(e => e.source === "untappd"));
  assert.ok(grounded.evidence.some(e => /酒厂背景/.test(e.summary)));

  const section = buildMenuPromptSection(memoryFor(grounded), "风之丘 评分多少");
  assert.match(section, /Untappd 无可用评分/);
  assert.doesNotMatch(section, /4\.2|3\.93|68496|untappd\.com\/beer\/111/);
  assert.match(section, /\[来源:social_web\]/);
  assert.match(section, /酒厂背景/);
  // Current OCR economics survive.
  assert.match(section, /60 CNY \/ 300ml|60\s*\/\s*300ml/);
});

// ── All 17 rows still ground by exact menu/Chinese names; known negatives refuse ──

test("all 17 rows ground by menu_name, name_zh and canonical brewery; counts and unresolved flags intact", () => {
  const fixtures = realEntries.map(e => candidate({
    candidateId: `ocr_${e.menu_index}`,
    menuIndex: e.menu_index,
    displayName: e.menu_name,
    brewery: e.brewery,
    abv: e.observation.abv ?? 0,
    evidence: [
      { source: "ocr", confidence: 0.9, summary: `menu #${e.menu_index} ${e.menu_name}` },
      ...(typeof e.observation.abv === "number" ? [ocrMenuAbvEvidence(e.observation.abv)] : []),
    ],
  }));
  const grounded = groundMenuSupplements(fixtures, realEntries);
  assert.equal(grounded.length, 17);
  for (const [i, e] of realEntries.entries()) {
    const g = getSupplementGrounding(grounded[i]);
    assert.equal(g?.entryId, e.id, `${e.menu_name} must ground to itself`);
    if (e.identity_status === "version_unresolved") {
      assert.ok(grounded[i].riskFlags.includes(RISK_SUPPLEMENT_VERSION_UNRESOLVED));
    } else if (e.identity_status === "batch_unresolved") {
      assert.ok(grounded[i].riskFlags.includes(RISK_SUPPLEMENT_BATCH_UNRESOLVED));
    }
  }

  // Every Chinese name grounds with the canonical brewery.
  for (const e of realEntries) {
    const zh = groundOne(candidate({ displayName: e.name_zh, brewery: e.brewery }));
    assert.equal(getSupplementGrounding(zh)?.entryId, e.id, `${e.name_zh} must ground`);
  }

  // The exact #18 label-spelling alias grounds; the short brand #13 alias grounds.
  assert.equal(
    getSupplementGrounding(groundOne(candidate({ displayName: "归还一切（过四桶）", brewery: "Anchorage" })))?.entryId,
    "elnido-2026-10-18",
  );
  assert.equal(
    getSupplementGrounding(groundOne(candidate({ displayName: "Белоглазка", brewery: "Sergacore" })))?.entryId,
    "elnido-2026-10-13",
  );
});

test("known-negative variants still refuse to ground", () => {
  const negatives: Array<[string, string, number]> = [
    ["Double Blueberry Shake", "Great Notion", 9],      // old different beer
    ["Reclaim Me", "Anchorage", 15],                    // undated 15% variant
    ["归还一切", "Anchorage", 15],                        // undated Chinese title is equally ambiguous
    ["K-philia #2", "Totopia", 9.5],                    // versioned candidate, bare menu title only
    ["Иваныч 2.0", "Velka Morava", 4.9],                // different version
    ["Белоглазка", "Some Other Brewery", 5],            // right name, wrong brewery
    ["归还一切（过四桶）", "Other Brewery", 19.2],       // alias with wrong brewery
    ["Kiwi Fingers", "Totopia", 6.8],                   // right name, wrong brewery
  ];
  for (const [displayName, brewery, abv] of negatives) {
    const input = candidate({ displayName, brewery, abv });
    const out = groundOne(input);
    assert.equal(out, input, `${displayName} / ${brewery} must stay unmatched`);
    assert.equal(getSupplementGrounding(out), null);
  }
});

// ── Finding 4/6 dataset expectations visible through grounding ──

test("#6 alias wording is a labeled local inference, not an official alias confirmation", () => {
  const out = groundOne(candidate({ displayName: "Girls Gone", brewery: "Ology", abv: 7 }));
  const text = out.evidence.filter(e => e.source === "social_web")[0].summary;
  assert.match(text, /本地推断/);
  assert.match(text, /未确认/);
});

test("#15 evidence links never include the FreeLunch BeerAdvocate page", () => {
  const out = groundOne(candidate({
    displayName: "Double Blueberry Marshmallow Shake",
    brewery: "Great Notion",
    abv: 9,
    evidence: [ocrMenuAbvEvidence(9)],
  }));
  const text = out.evidence.filter(e => e.source === "social_web")[0].summary;
  assert.ok(!text.includes("48592/794227"));
  assert.match(text, /41869\/526417/);
  assert.match(text, /拒绝采信/);
});

void byIndex;
