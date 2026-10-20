// Standalone native-Node tests for the El Nido curated menu supplement.
// Run:
//   node --experimental-strip-types --test tests/menu-supplements.test.mts
// No model/DB/network calls; fixtures are synthetic plus the real public 17-file.

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
  RISK_SUPPLEMENT_ABV_CONFLICT,
  RISK_SUPPLEMENT_VERSION_UNRESOLVED,
  RISK_SUPPLEMENT_BATCH_UNRESOLVED,
  RISK_SUPPLEMENT_NO_RATING,
  type MenuSupplementEntry,
} from "../lib/beer-agent/menu-supplements.ts";

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
    ibu: over.ibu ?? null,
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
    breweryCountry: over.breweryCountry ?? null,
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

const ground = (c: ReturnType<typeof candidate>, rs: MenuSupplementEntry[] = realEntries) =>
  groundMenuSupplements([c], rs)[0];

const socialEvidence = (c: ReturnType<typeof candidate>) =>
  c.evidence.filter(e => e.source === "social_web");

// ── Real file: exact 17 metadata ──

test("real file has exactly 17 entries on taps 2..18, in order, with stable ids", () => {
  assert.equal(realEntries.length, 17);
  assert.deepEqual(realEntries.map(e => e.menu_index), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const ids = new Set(realEntries.map(e => e.id));
  assert.equal(ids.size, 17, "ids are unique");
  for (const e of realEntries) {
    assert.match(e.id, /^elnido-2026-10-(0[2-9]|1[0-8])$/);
    assert.equal(e.observation.currency, "CNY");
    assert.equal(e.observation.observed_at, "2026-10-20");
    assert.equal(e.observation.source, "menu_transcription");
    for (const s of e.sources) {
      assert.ok(["brewery", "retailer", "community"].includes(s.kind));
      assert.equal(s.access, "web_index_or_cache");
      assert.equal(s.checked_at, "2026-10-21");
      assert.match(s.url, /^https:\/\//);
    }
  }
  const confirmed = realEntries.filter(e => e.identity_status === "confirmed");
  assert.equal(confirmed.length, 15);
});

test("15 confirmed entries carry canonical name/style/abv; records carry no usable score/UT fields", () => {
  for (const e of realEntries) {
    // No usable score fields exist on the record itself.
    for (const forbidden of ["rating", "rating_raw", "ratings_count", "untappd_id", "untappdId", "untappdScore"]) {
      assert.equal((e as Record<string, unknown>)[forbidden], undefined, `${e.id} must not define ${forbidden}`);
    }
    if (e.identity_status === "confirmed") {
      assert.ok(e.canonical_name && e.canonical_name.length > 0);
      assert.equal(typeof e.abv, "number");
    }
  }
  // The #12 conflict is preserved as a documented disagreement (historical
  // snapshots only), never promoted into a usable top-level score.
  const fl = byIndex.get(12)!;
  assert.ok(fl.field_disagreements.historical_rating_snapshots);
});

test("#11 is version_unresolved and #17 is batch_unresolved: null canonical/style/abv, observation kept", () => {
  const k = byIndex.get(11)!;
  assert.equal(k.identity_status, "version_unresolved");
  assert.equal(k.canonical_name, null);
  assert.equal(k.style, null);
  assert.equal(k.abv, null);
  assert.equal(k.observation.abv, 9.5);
  assert.deepEqual(k.aliases, [], "bare K-philia must not alias K-philia #2");

  const cut = byIndex.get(17)!;
  assert.equal(cut.identity_status, "batch_unresolved");
  assert.equal(cut.canonical_name, null);
  assert.equal(cut.style, null);
  assert.equal(cut.abv, null);
  assert.equal(cut.observation.abv, 6);
});

test("all expected explicit aliases: #6 short title, #18 label-spelling Chinese alias; brewery aliases #10/#13", () => {
  assert.deepEqual(byIndex.get(6)!.aliases, ["Girls Gone"]);
  assert.equal(byIndex.get(6)!.canonical_name, "Girls Gone Hazy");
  assert.deepEqual(byIndex.get(18)!.aliases, ["归还一切（过四桶）"]);
  assert.deepEqual(byIndex.get(10)!.brewery_aliases, ["Shred Beer Company"]);
  assert.deepEqual(byIndex.get(13)!.brewery_aliases, ["Sergacore"]);
  assert.equal(byIndex.get(13)!.brewery, "Sergacore Brewery");
  // No arbitrary name aliases on any other row.
  for (const e of realEntries.filter(x => x.menu_index !== 6 && x.menu_index !== 18)) assert.deepEqual(e.aliases, []);
  // No invented brewery aliases beyond Shred / Sergacore.
  for (const e of realEntries.filter(x => x.menu_index !== 10 && x.menu_index !== 13)) assert.deepEqual(e.brewery_aliases, []);
});

// ── Strict identity matching ──

test("Unicode exact names ground: Иваныч (#7) and Белоглазка (#13)", () => {
  const ivanych = ground(candidate({ displayName: "Иваныч", brewery: "Velka Morava", abv: 4.9 }));
  assert.equal(getSupplementGrounding(ivanych)?.entryId, "elnido-2026-10-07");
  assert.equal(ivanych.abv, 4.9);

  const belka = ground(candidate({ displayName: "Белоглазка", brewery: "Sergacore", abv: 5 }));
  assert.equal(getSupplementGrounding(belka)?.entryId, "elnido-2026-10-13");
});

test("Chinese name_zh grounds strictly too", () => {
  const out = ground(candidate({ displayName: "风之丘", brewery: "Mikkeller" }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-02");
});

test("BigPot: punctuation-insensitive normalized match to Big Pot #16", () => {
  const out = ground(candidate({ displayName: "Grandma's Feijoa", brewery: "BigPot", abv: 6.5 }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-16");
  assert.equal(out.brewery, "BigPot", "OCR brewery string preserved verbatim");
});

test("brewery alias accepts full legal name Shred Beer Company for Green Reaper #10", () => {
  const out = ground(candidate({ displayName: "Green Reaper", brewery: "Shred Beer Company", abv: 6.7 }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-10");
  assert.equal(out.abv, 6.66, "canonical exact ABV supersedes one-decimal OCR within rounding tolerance");
});

test("wrong brewery never grounds, even on exact name", () => {
  const input = candidate({ displayName: "Kiwi Fingers", brewery: "Totopia", abv: 6.8 });
  const out = ground(input);
  assert.equal(out, input);
  assert.equal(getSupplementGrounding(out), null);
});

test("short menu title Girls Gone grounds to #6 with a label-local-inference provenance note", () => {
  const out = ground(candidate({ displayName: "Girls Gone", brewery: "Ology", abv: 7 }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-06");
  assert.equal(out.displayName, "Girls Gone", "OCR display title is preserved, not rewritten");
  assert.equal(out.abv, 7);
  const text = socialEvidence(out)[0].summary;
  assert.match(text, /Girls Gone Hazy/);
  assert.match(text, /简写|别名|alias/i);
  // The title match is a local inference (title+brewery+ABV), never presented
  // as an official confirmation of this venue's short-title alias.
  assert.match(text, /本地推断/);
  assert.match(text, /未确认/);
  assert.doesNotMatch(text, /官方页面确认是|经.*确认是/);
});

test("dated variant discipline: bare 'Reclaim Me' (undated 15% beer) never matches Reclaim Me 2026", () => {
  const input = candidate({ displayName: "Reclaim Me", brewery: "Anchorage", abv: 15 });
  const out = ground(input);
  assert.equal(out, input);
  assert.equal(getSupplementGrounding(out), null);
  assert.equal(out.abv, 15);
});

test("tap/menuIndex alone never grounds: unknown name at menuIndex 10 stays unmatched", () => {
  const input = candidate({ displayName: "Mystery Pour", brewery: "Shred", menuIndex: 10 });
  const out = ground(input);
  assert.equal(out, input);
  assert.equal(getSupplementGrounding(out), null);
});

test("unique result required: same display name resolvable to two entries stays unmatched", () => {
  const synth: MenuSupplementEntry[] = [
    {
      ...byIndex.get(4)!,
      id: "syn-1",
      menu_index: 4,
      menu_name: "Same Name",
      name_zh: "",
      canonical_name: "Same Name",
      aliases: [],
      brewery: "Brewery A",
      brewery_aliases: [],
    },
    {
      ...byIndex.get(5)!,
      id: "syn-2",
      menu_index: 5,
      menu_name: "Same Name",
      name_zh: "",
      canonical_name: "Same Name",
      aliases: [],
      brewery: "Brewery A",
      brewery_aliases: [],
    },
  ];
  const input = candidate({ displayName: "Same Name", brewery: "Brewery A" });
  assert.equal(ground(input, synth), input, "duplicate name+brewery must not silently pick one");
});

// ── Unresolved rows ──

test("#11 K-philia: unresolved grounding preserves explicitly-read OCR style/ABV only, no canonical override or score transfer", () => {
  const stale = candidate({
    displayName: "K-philia",
    brewery: "Totopia",
    abv: 9.5,
    style: "DDH West Coast Triple IPA",
    untappdId: "6063476",
    untappdScore: 4.1,
    untappdRatingCount: 88,
    untappdUrl: "https://untappd.com/b/totopia-brewery-k-philia/6063476",
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu: K-philia 9.5%" },
      ocrMenuAbvEvidence(9.5),
      // Provider marks a style the model actually read on the image.
      ocrMenuStyleEvidence("DDH West Coast Triple IPA"),
    ],
  });
  const out = ground(stale);
  const g = getSupplementGrounding(out);
  assert.equal(g?.entryId, "elnido-2026-10-11");
  assert.equal(g?.identityStatus, "version_unresolved");
  assert.equal(out.abv, 9.5, "OCR observation preserved, not overwritten by candidate #2 or old 8.5");
  assert.equal(out.style, "DDH West Coast Triple IPA", "OCR style left as-is, no canonical style injected");
  assert.equal(out.untappdId, null, "old-version UT id must not ride along");
  assert.equal(out.untappdScore, null);
  assert.equal(out.untappdRatingCount, null);
  assert.equal(out.untappdUrl, null);
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_VERSION_UNRESOLVED));
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_NO_RATING));
  const text = socialEvidence(out)[0].summary;
  assert.match(text, /版本待确认|version_unresolved|版本未确认/);
  assert.match(text, /8\.5/);
  assert.match(text, /#2/);
  assert.match(text, /不迁移|不能自动/);
});

test("#17 The Cut: batch unresolved, OCR 6% kept, series scoped, no 2017 identity/score transfer", () => {
  const stale = candidate({
    displayName: "The Cut: Laroda Plum",
    brewery: "Casey",
    abv: 6,
    untappdId: "2516105",
    untappdScore: 4.44,
    untappdRatingCount: 452,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu" }, ocrMenuAbvEvidence(6)],
  });
  const out = ground(stale);
  assert.equal(getSupplementGrounding(out)?.identityStatus, "batch_unresolved");
  assert.equal(out.abv, 6);
  assert.equal(out.untappdId, null);
  assert.equal(out.untappdScore, null);
  assert.equal(out.untappdRatingCount, null);
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_BATCH_UNRESOLVED));
  const text = socialEvidence(out)[0].summary;
  assert.match(text, /批次/);
  assert.match(text, /2017/);
  assert.match(text, /5%/); // generic series ABV documented but not applied
});

test("#11/#17 unresolved: legacy-only ABV/style (no explicit OCR channel) is cleared to unknown", () => {
  // Assembled candidate carrying ONLY old per-beer evidence: stale 8.5%
  // Imperial Oat Cream IPA K-philia from an old Untappd/cache record.
  const legacyK = candidate({
    displayName: "K-philia",
    brewery: "Totopia",
    abv: 8.5,
    style: "Imperial Oat Cream IPA",
    untappdId: "6063476",
    untappdScore: 4.2,
    untappdRatingCount: 88,
    untappdUrl: "https://untappd.com/b/totopia-brewery-k-philia/6063476",
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu: K-philia" },
      { source: "untappd", confidence: 0.9, summary: "本地 beer_cache 酒款记录：Totopia / K-philia，评分 4.2，88 次评分" },
    ],
  });
  const outK = ground(legacyK);
  assert.equal(getSupplementGrounding(outK)?.identityStatus, "version_unresolved");
  assert.equal(outK.abv, 0, "legacy 8.5 must not survive without an explicit OCR ABV marker");
  assert.equal(outK.style, "", "legacy Old Style must not survive without an explicit OCR style marker");
  assert.equal(outK.untappdScore, null);
  assert.ok(!outK.evidence.some(e => e.source === "untappd"), "stale per-beer rating evidence pruned");
  assert.ok(!socialEvidence(outK)[0].summary.includes("0%"), "unknown ABV is never rendered as 0%");

  // The same row WITH explicit OCR observations keeps exactly those facts.
  const ocrK = ground(candidate({
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
  assert.equal(ocrK.abv, 9.5, "explicit OCR ABV retained verbatim");
  assert.equal(ocrK.style, "DDH West Coast Triple IPA", "explicit OCR style retained verbatim");

  const legacyCut = candidate({
    displayName: "The Cut: Laroda Plum",
    brewery: "Casey",
    abv: 6,
    style: "Wild Ale",
    untappdScore: 4.44,
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu row" },
      { source: "untappd", confidence: 0.9, summary: "本地 beer_cache 酒款记录：Casey / The Cut，评分 4.44" },
    ],
  });
  const outCut = ground(legacyCut);
  assert.equal(getSupplementGrounding(outCut)?.identityStatus, "batch_unresolved");
  assert.equal(outCut.abv, 0, "no explicit OCR ABV -> unknown, never the 2017 batch value");
  assert.equal(outCut.style, "");

  const ocrCut = ground(candidate({
    displayName: "The Cut: Laroda Plum",
    brewery: "Casey",
    abv: 6,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 6%" }, ocrMenuAbvEvidence(6)],
  }));
  assert.equal(ocrCut.abv, 6, "explicit OCR observation preserved");
  assert.equal(ocrCut.style, "");
});

// ── Invalidated per-beer evidence / derived value fields (finding 3) ──

test("matched rows prune stale per-beer rating/identity evidence but keep OCR, user and brewery-level background", () => {
  const out = ground(candidate({
    displayName: "Windy Hill",
    brewery: "Mikkeller",
    abv: 0,
    style: "",
    untappdScore: 3.93,
    labelImage: "https://img.example.com/windy-label.jpg",
    valueScore: 71,
    originBenchmark: 88,
    savingsVsOrigin: 12,
    pricePerMl: 0.99,
    price: 60,
    volumeMl: 300,
    currency: "CNY",
    evidence: [
      { source: "ocr", confidence: 0.9, summary: "menu: Windy Hill" },
      { source: "untappd", confidence: 0.9, summary: "已核验 Mikkeller / Windy Hill：3.93 https://untappd.com/beer/111" },
      { source: "agent_inference", confidence: 0.95, summary: "本地 ratebeer 酒款记录：Mikkeller / Windy Hill，评分 4.0，12 次评分 https://example.com/rb" },
      { source: "agent_inference", confidence: 0.5, summary: "酒厂背景（非本款评分）：Mikkeller 库内 42 款均分 3.8；本款评分未知。" },
      { source: "user_profile", confidence: 0.8, summary: "用户喜欢浑浊 IPA" },
    ],
  }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-02");
  assert.ok(!out.evidence.some(e => e.source === "untappd"), "untappd per-beer snippet removed");
  assert.ok(!out.evidence.some(e => /酒款记录：/.test(e.summary)), "legacy per-beer rating snippet removed");
  assert.ok(out.evidence.some(e => /酒厂背景（非本款评分）/.test(e.summary)), "brewery-level background kept");
  assert.ok(out.evidence.some(e => e.source === "ocr"), "original OCR evidence kept");
  assert.ok(out.evidence.some(e => e.source === "user_profile"), "user evidence kept");
  assert.equal(out.labelImage, null, "stale label image cleared with its invalidated identity");
  assert.equal(out.valueScore, null);
  assert.equal(out.originBenchmark, null);
  assert.equal(out.savingsVsOrigin, null);
  assert.equal(out.pricePerMl, null, "0.99 is an old-record estimate, not 60/300; dropped");
  assert.equal(out.price, 60, "current OCR price preserved");
  assert.equal(out.volumeMl, 300, "current OCR volume preserved");
  // The new social_web evidence is the only sourced supplement; no score leaks.
  const text = socialEvidence(out)[0].summary;
  assert.doesNotMatch(text, /3\.93|4\.0/);
});

test("pricePerMl exactly reproducible from current OCR price/volume is kept", () => {
  const out = ground(candidate({
    displayName: "Windy Hill",
    brewery: "Mikkeller",
    price: 60,
    volumeMl: 300,
    pricePerMl: 0.2,
  }));
  assert.equal(out.pricePerMl, 0.2);
});

// ── Reviewed source corrections on the real 17-file (finding 4) ──

test("#15 sources: FreeLunch BeerAdvocate URL removed; the rejected page is mentioned only as rejected", () => {
  const e15 = byIndex.get(15)!;
  assert.ok(!e15.sources.some(s => s.url.includes("beeradvocate.com")), "no active BeerAdvocate source");
  assert.ok(!e15.sources.some(s => s.url.includes("48592/794227")));
  const out = ground(candidate({
    displayName: "Double Blueberry Marshmallow Shake",
    brewery: "Great Notion",
    abv: 9,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 9" }, ocrMenuAbvEvidence(9)],
  }));
  const text = socialEvidence(out)[0].summary;
  // The 48592/794227 page belongs to Free Lunch and never appears on #15.
  assert.ok(!text.includes("48592/794227"));
  // The actual mistaken-description page survives only in a rejected framing.
  assert.ok(text.includes("41869/526417"));
  assert.match(text, /41869\/526417\/）的“Double Berry”说法已拒绝采信|已拒绝采信/);
  // Free Lunch still legitimately carries its own BeerAdvocate page.
  const e12 = byIndex.get(12)!;
  assert.ok(e12.sources.some(s => s.url.endsWith("/profile/48592/794227/")));
});

test("#2 Carlsberg shop is retailer/distributor, not brewery kind", () => {
  const e2 = byIndex.get(2)!;
  const carlsberg = e2.sources.find(s => s.url.includes("carlsbergdanmark.dk"))!;
  assert.equal(carlsberg.kind, "retailer");
});

test("#18 exact label alias 归还一切（过四桶）grounds to Reclaim Me 2026 and keeps its 2026 identity", () => {
  const out = ground(candidate({ displayName: "归还一切（过四桶）", brewery: "Anchorage", abv: 19.2 }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-18");
  assert.equal(out.abv, 19.25, "2026 canonical exact ABV; barrel spelling does not switch identity");
  assert.match(socialEvidence(out)[0].summary, /酒标拼写|桶序/);
  // The dated negative variant still refuses.
  const old = candidate({ displayName: "Reclaim Me", brewery: "Anchorage", abv: 15 });
  assert.equal(ground(old), old);
});

test("#13 full canonical brewery is Sergacore Brewery; short printed Sergacore is an explicit alias", () => {
  const full = ground(candidate({ displayName: "Белоглазка", brewery: "Sergacore Brewery", abv: 5 }));
  assert.equal(getSupplementGrounding(full)?.entryId, "elnido-2026-10-13");
  const short = ground(candidate({ displayName: "Белоглазка", brewery: "Sergacore", abv: 5 }));
  assert.equal(getSupplementGrounding(short)?.entryId, "elnido-2026-10-13", "printed short brand still grounds via alias");
});

// ── Structural guard at read/apply boundary (finding 5) ──

test("malformed rows (null source, bad issue, NaN, bad observation) are skipped; valid rows still ground", () => {
  const good = byIndex.get(13)!;
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["sources:[null]", { sources: [null] }],
    ["sources missing required url", { sources: [{ kind: "community", access: "web_index_or_cache", checked_at: "2026-10-21", fields: ["identity"] }] }],
    ["sources wrong kind", { sources: [{ url: "https://example.com", kind: "blog", access: "web_index_or_cache", checked_at: "2026-10-21", fields: ["identity"] }] }],
    ["issues not strings", { issues: ["ok", 5] }],
    ["abv NaN", { abv: Number.NaN }],
    ["observation abv negative", { observation: { abv: -1, price: 1, volume_ml: 1, currency: "CNY", observed_at: "2026-10-20", source: "menu_transcription" } }],
    ["observation wrong currency", { observation: { abv: 1, price: 1, volume_ml: 1, currency: "USD", observed_at: "2026-10-20", source: "menu_transcription" } }],
    ["fields non-string", { sources: [{ url: "https://example.com", kind: "community", access: "web_index_or_cache", checked_at: "2026-10-21", fields: ["ok", 7] }] }],
  ];
  for (const [label, patch] of malformed) {
    const mixed = [{ ...good, ...patch }, good] as unknown as MenuSupplementEntry[];
    const out = ground(candidate({ displayName: "Белоглазка", brewery: "Sergacore Brewery" }), mixed);
    assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-13", `${label}: bad row skipped, good row grounds, no crash`);
  }
  // A sources:[null] row on its own is rejected and leaves the candidate as-is.
  const onlyBad = [{ ...good, sources: [null] }] as unknown as MenuSupplementEntry[];
  const input = candidate({ displayName: "Белоглазка", brewery: "Sergacore Brewery" });
  assert.equal(ground(input, onlyBad), input);
});

// ── Confirmed rows: fact fills, ABV tolerance, conflicts always flagged ──

test("#2 confirmed: fills missing style/abv, description and provenance attached as social_web", () => {
  const stale = candidate({
    displayName: "Windy Hill",
    brewery: "Mikkeller",
    abv: 0,
    style: "",
    untappdId: "111",
    untappdScore: 3.93,
    untappdRatingCount: 68496,
    untappdUrl: "https://untappd.com/beer/111",
  });
  const out = ground(stale);
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-02");
  assert.equal(out.abv, 7);
  assert.equal(out.style, "Hazy IPA (NEIPA)");
  assert.equal(out.untappdId, null, "historical UT id is not created or carried");
  assert.equal(out.untappdScore, null, "historical 3.93/68496 omitted per contract");
  assert.equal(out.untappdRatingCount, null);
  assert.equal(out.untappdUrl, null);
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_NO_RATING));

  const ev = socialEvidence(out);
  assert.equal(ev.length, 1);
  const text = ev[0].summary;
  assert.match(text, /风之丘|热带水果/);
  assert.match(text, /https:\/\/untappd\.com\/b\/mikkeller-windy-hill\/2068818/);
  assert.match(text, /https:\/\/shop\.carlsbergdanmark\.dk/);
  assert.match(text, /2026-10-21/);
  assert.match(text, /2026-10-20/);
  assert.match(text, /menu_id:elnido-2026-10/);
  assert.match(text, /menu_supplement:elnido-2026-10-02/);
  // hops disagreement preserved, specific hop claims withheld
  assert.match(text, /酒花/);
  // Not attributed to untappd/venue_site channels.
  assert.ok(!out.evidence.some(e => e.source === "venue_site"));
  assert.ok(!/event_beer_id/.test(text));
});

test("ABV rounding tolerance: #10 6.66 vs OCR 6.7 and #18 19.25 vs OCR 19.2 are not conflicts", () => {
  const shred = ground(candidate({
    displayName: "Green Reaper",
    brewery: "Shred",
    abv: 6.7,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 6.7" }, ocrMenuAbvEvidence(6.7)],
  }));
  assert.equal(shred.abv, 6.66);
  assert.ok(!shred.riskFlags.includes(RISK_SUPPLEMENT_ABV_CONFLICT));
  assert.match(socialEvidence(shred)[0].summary, /6\.66/);

  const reclaim = ground(candidate({
    displayName: "Reclaim Me 2026",
    brewery: "Anchorage",
    abv: 19.2,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 19.2" }, ocrMenuAbvEvidence(19.2)],
  }));
  assert.equal(reclaim.abv, 19.25);
  assert.ok(!reclaim.riskFlags.includes(RISK_SUPPLEMENT_ABV_CONFLICT));
});

test("#15: OCR 9 vs canonical 9 agrees numerically but source disagreement 9 vs 9.1 is always flagged and preserved", () => {
  const out = ground(candidate({
    displayName: "Double Blueberry Marshmallow Shake",
    brewery: "Great Notion",
    abv: 9,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 9" }, ocrMenuAbvEvidence(9)],
  }));
  assert.equal(out.abv, 9, "OCR/menu value retained");
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_ABV_CONFLICT));
  const text = socialEvidence(out)[0].summary;
  assert.match(text, /9\.1/);
  assert.match(text, /分歧|冲突|disagree/i);
  assert.match(text, /Double Blueberry Shake/);
});

test("#5: 5 vs 4.9 public disagreement is flagged even though OCR equals the canonical 5", () => {
  const out = ground(candidate({
    displayName: "Good Idea",
    brewery: "Ology",
    abv: 5,
    evidence: [ocrMenuAbvEvidence(5)],
  }));
  assert.equal(out.abv, 5);
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_ABV_CONFLICT));
  assert.match(socialEvidence(out)[0].summary, /4\.9/);
});

test("OCR ABV beyond tolerance is preserved verbatim and flagged (#15 OCR 9.1 hypothetical)", () => {
  const out = ground(candidate({
    displayName: "Double Blueberry Marshmallow Shake",
    brewery: "Great Notion",
    abv: 9.1,
    evidence: [{ source: "ocr", confidence: 0.9, summary: "menu 9.1" }, ocrMenuAbvEvidence(9.1)],
  }));
  assert.equal(out.abv, 9.1, "OCR value preserved, not silently replaced by canonical 9");
  assert.ok(out.riskFlags.includes(RISK_SUPPLEMENT_ABV_CONFLICT));
});

test("stale legacy ABV without OCR claim is superseded by canonical value", () => {
  const out = ground(candidate({ displayName: "Free Lunch", brewery: "BlackStack", abv: 8.2, style: "IPA" }));
  assert.equal(out.abv, 10.1);
  assert.equal(out.style, "Triple New England / Hazy IPA", "missing/stale style filled by canonical known style");
});

// ── OCR field preservation and no price injection ──

test("OCR price/volume/currency/menuIndex are preserved and snapshot prices are never injected", () => {
  const withPrice = ground(candidate({
    displayName: "Victory Lap",
    brewery: "Ology",
    price: 90,
    volumeMl: 300,
    currency: "CNY",
    menuIndex: 4,
  }));
  assert.equal(withPrice.price, 90);
  assert.equal(withPrice.volumeMl, 300);
  assert.equal(withPrice.currency, "CNY");
  assert.equal(withPrice.menuIndex, 4);

  // A candidate that did not OCR a price must not receive the snapshot 60/90 CNY.
  const noPrice = ground(candidate({ displayName: "Windy Hill", brewery: "Mikkeller", menuIndex: 2 }));
  assert.equal(noPrice.price, null);
  assert.equal(noPrice.volumeMl, null);

  // The social evidence never carries a snapshot price/volume to leak elsewhere.
  const text = socialEvidence(noPrice)[0].summary;
  assert.doesNotMatch(text, /¥|CNY\s*\d|\b60\b|\b300ml/i);
});

test("description scope: evidence is dated and says the price is a snapshot observation, not current inventory", () => {
  const out = ground(candidate({ displayName: "Pils For Skills", brewery: "Velka Morava" }));
  const text = socialEvidence(out)[0].summary;
  assert.match(text, /2026-10-20/);
  assert.match(text, /转录|快照|snapshot/i);
});

// ── #13 existing DB product ──

test("#13 grounds but clears any inherited score (existing DB row is the importer's job to preserve)", () => {
  const out = ground(candidate({
    displayName: "Белоглазка",
    brewery: "Sergacore",
    untappdId: "6031526",
    untappdScore: 4.05,
    untappdRatingCount: 22,
  }));
  assert.equal(getSupplementGrounding(out)?.entryId, "elnido-2026-10-13");
  assert.equal(out.untappdId, null);
  assert.equal(out.untappdScore, null);
  assert.equal(out.untappdRatingCount, null);
  assert.match(socialEvidence(out)[0].summary, /思慕雪|甜点酸/);
});

// ── Purity / fail-soft ──

test("groundMenuSupplements is pure: inputs and entries never mutated; unmatched returned as-is", () => {
  const input = candidate({ displayName: "King Lear", brewery: "Velka Morava", abv: 4.7 });
  const entriesSnapshot = JSON.parse(JSON.stringify(realEntries));
  const inputSnapshot = JSON.parse(JSON.stringify(input));
  const out = ground(input);
  assert.notEqual(out, input, "match returns a clone");
  assert.deepEqual(JSON.parse(JSON.stringify(input)), inputSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(realEntries)), entriesSnapshot);

  const unknown = candidate({ displayName: "Nope", brewery: "Nowhere" });
  assert.equal(ground(unknown), unknown);

  assert.deepEqual(groundMenuSupplements([input], []), [input]);
  assert.deepEqual(groundMenuSupplements([input], [{ broken: true }] as unknown as MenuSupplementEntry[]), [input]);
});

test("readMenuSupplements fails soft on missing/malformed/non-object and filters bad rows", async () => {
  const cwd = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), "elnido-supplement-"));
  const menusDir = path.join(dir, "data", "menus");
  const file = path.join(menusDir, "elnido-2026-10.json");
  try {
    process.chdir(dir);
    assert.deepEqual(await readMenuSupplements(), [], "missing file -> []");

    await mkdir(menusDir, { recursive: true });
    await writeFile(file, "{ nope", "utf8");
    assert.deepEqual(await readMenuSupplements(), [], "malformed JSON -> []");

    await writeFile(file, JSON.stringify([1, 2, 3]), "utf8");
    assert.deepEqual(await readMenuSupplements(), [], "non-object payload -> []");

    await writeFile(file, JSON.stringify({ version: 1, menu_id: "elnido-2026-10", entries: [{ broken: true }, realEntries[0]] }), "utf8");
    const loaded = await readMenuSupplements();
    assert.equal(loaded.length, 1, "bad rows filtered, valid row survives");
    assert.equal(loaded[0].id, "elnido-2026-10-02");
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMenuSupplements loads the real 17-entry file from cwd", async () => {
  const cwd = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), "elnido-supplement-real-"));
  const menusDir = path.join(dir, "data", "menus");
  try {
    await mkdir(menusDir, { recursive: true });
    // workspace root is two levels up from tests/; simpler: point cwd at repo root
    process.chdir(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
    const loaded = await readMenuSupplements();
    assert.equal(loaded.length, 17);
    const kphilia = loaded.find(e => e.menu_index === 11);
    assert.equal(kphilia?.identity_status, "version_unresolved");
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});
