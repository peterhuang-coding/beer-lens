import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  groundMenuCandidates,
  readEventCatalog,
  getGrounding,
  ocrExplicitAbvEvidence,
  RISK_EVENT_ABV_UNKNOWN,
  RISK_EVENT_RATING_UNUSABLE,
  RISK_EVENT_ABV_CONFLICT,
} from "../lib/beer-agent/event-grounding.ts";

const fixtureRaw = await readFile(new URL("./fixtures/mbcb-grounding-current.json", import.meta.url), "utf8");
const records = JSON.parse(fixtureRaw);
const byId = Object.fromEntries(records.map(r => [r.event_beer_id, r]));

function candidate(over = {}) {
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
    riskFlags: [...(over.riskFlags ?? [])],
    reason: "",
    evidence: over.evidence ?? [{ source: "ocr", confidence: 0.5, summary: "poster raw text" }],
    untappdId: over.untappdId ?? null,
    untappdScore: over.untappdScore ?? null,
    untappdRatingCount: over.untappdRatingCount ?? null,
    untappdUrl: over.untappdUrl ?? null,
    breweryCountry: over.breweryCountry ?? null,
    labelImage: null,
    currency: over.currency,
    servingMode: over.servingMode,
    price: over.price ?? null,
    volumeMl: over.volumeMl ?? null,
  };
}

const ground = (c, rs = records) => groundMenuCandidates([c], rs)[0];
const venueEvidence = c => c.evidence.filter(e => e.source === "venue_site");

// ── #498: strict exact name + Mikkeller resolves ABV, stale style/UT purged ──

test("#498 exact name + Mikkeller grounds ABV 7.5 but style/description/UT stay unknown", () => {
  const stale = candidate({
    displayName: "Mikkeller Ice Tea Powered by Longfong",
    brewery: "Mikkeller",
    abv: 6.0, // stale legacy value
    style: "Fruited Sour", // stale, unrelated DB row
    untappdId: "999999",
    untappdScore: 4.21,
    untappdRatingCount: 1337,
    untappdUrl: "https://untappd.com/beer/999999",
  });
  const out = ground(stale);
  const g = getGrounding(out);

  assert.equal(g?.eventBeerId, 498);
  assert.equal(out.abv, 7.5, "known catalog ABV supersedes stale legacy ABV");
  assert.equal(out.style, "", "absent catalog style must not be filled from stale DB");
  assert.equal(out.untappdScore, null, "rating_usable false must not keep a stale score");
  assert.equal(out.untappdRatingCount, null);
  assert.equal(out.untappdId, null, "catalog untappd_id null purges stale wrong-beer id");
  assert.equal(out.untappdUrl, null);
  assert.ok(out.riskFlags.includes(RISK_EVENT_RATING_UNUSABLE));

  const ev = venueEvidence(out);
  assert.equal(ev.length, 1);
  const text = ev[0].summary;
  assert.match(text, /mbcb-2026-beijing/);
  assert.match(text, /#498/);
  assert.match(text, /\[event_beer_id:498]/);
  assert.match(text, /https:\/\/mbcb\.jonpacker\.com\/latest\.json/);
  assert.match(text, /2026-10-16/);
  assert.match(text, /ABV 7\.5%/);
  assert.match(text, /无描述/);
  assert.match(text, /Untappd 无有效评分/);
  assert.ok(!text.includes("Fruited Sour"));
});

test("#498 unique name grounds even without brewery", () => {
  const out = ground(candidate({ displayName: "Mikkeller Ice Tea Powered by Longfong" }));
  assert.equal(getGrounding(out)?.eventBeerId, 498);
});

// ── #96 / #599: Helles ambiguity and brewery scoping ──

test("Helles without brewery is ambiguous and stays unmatched", () => {
  const input = candidate({ displayName: "Helles", abv: 4.7, style: "Lager" });
  const out = ground(input);
  assert.equal(out, input, "ambiguous candidate returned untouched");
  assert.equal(getGrounding(out), null);
  assert.equal(out.abv, 4.7);
});

test("Helles + 3 Sons (menuIndex 599) grounds to #96, never by number", () => {
  const out = ground(candidate({ displayName: "Helles", brewery: "3 Sons", menuIndex: 599 }));
  assert.equal(getGrounding(out)?.eventBeerId, 96);
  assert.equal(out.abv, 5);
  assert.equal(out.style, "Helles Lager");
  assert.equal(out.menuIndex, 599, "menuIndex is the poster row and is preserved");
});

test("Helles + Wagner Merkendorf grounds to #599", () => {
  const out = ground(candidate({ displayName: "Helles", brewery: "Wagner Merkendorf", menuIndex: 96 }));
  assert.equal(getGrounding(out)?.eventBeerId, 599, "menuIndex 96 must not link to event #96");
  assert.equal(out.abv, 4.7);
});

test("Helles Chinese name + Chinese brewery resolves strictly (三子→96, 韦格纳→599)", () => {
  const zhName = byId[599].name_zh; // identical zh name on both records
  const sons = ground(candidate({ displayName: zhName, brewery: "三子" }));
  assert.equal(getGrounding(sons)?.eventBeerId, 96);
  assert.equal(sons.abv, 5);

  const wagner = ground(candidate({ displayName: zhName, brewery: "韦格纳" }));
  assert.equal(getGrounding(wagner)?.eventBeerId, 599);
  assert.equal(wagner.abv, 4.7);

  const noBrewery = ground(candidate({ displayName: zhName }));
  assert.equal(getGrounding(noBrewery), null, "shared name_zh without brewery is ambiguous");
});

test("cross-brewery same name never grounds (Helles + Budvar)", () => {
  const input = candidate({ displayName: "Helles", brewery: "Budvar", abv: 5 });
  const out = ground(input);
  assert.equal(out, input);
  assert.equal(getGrounding(out), null);
  assert.equal(out.abv, 5);
});

// ── #93: unknown ABV is numeric 0 + explicit unknown, not alcohol-free ──

test("#93 Bohemian Machine: missing ABV stays 0 with unknown flag/evidence; zero UT is not a score", () => {
  const stale = candidate({
    displayName: "Bohemian Machine",
    brewery: "Budvar",
    abv: 4.9,
    style: "Czech Pils",
    untappdId: "888",
    untappdScore: 3.4,
    untappdRatingCount: 5,
  });
  const out = ground(stale);
  assert.equal(getGrounding(out)?.eventBeerId, 93);
  assert.equal(out.abv, 0);
  assert.ok(out.riskFlags.includes(RISK_EVENT_ABV_UNKNOWN));
  const text = venueEvidence(out)[0].summary;
  assert.match(text, /未知/);
  assert.match(text, /不代表无醇|非无醇/);
  assert.equal(out.style, "Czech Pilsner", "known catalog style supersedes stale DB variant");
  assert.equal(out.untappdId, "7223005", "catalog UT id is an identifier and is attached");
  assert.equal(out.untappdUrl, "https://untappd.com/beer/7223005");
  assert.equal(out.untappdScore, null, "rating_raw 0 / count 0 / usable false is no rating");
  assert.equal(out.untappdRatingCount, null);
  assert.ok(out.riskFlags.includes(RISK_EVENT_RATING_UNUSABLE));
});

// ── #305: full usable catalog facts supersede stale legacy values ──

test("#305 Starboy: usable rating/style/ABV from catalog supersede stale legacy fields", () => {
  const stale = candidate({
    displayName: "Starboy",
    brewery: "Honey Pot",
    abv: 8,
    style: "Imperial IPA",
    untappdId: "111",
    untappdScore: 3.9,
    untappdRatingCount: 10,
  });
  const out = ground(stale);
  assert.equal(getGrounding(out)?.eventBeerId, 305);
  assert.equal(out.abv, 12.5);
  assert.equal(out.style, "Melomel");
  assert.equal(out.untappdId, "3775114");
  assert.equal(out.untappdScore, 4.61603);
  assert.equal(out.untappdRatingCount, 527);
  assert.equal(out.untappdUrl, "https://untappd.com/beer/3775114");
  assert.ok(!out.riskFlags.includes(RISK_EVENT_RATING_UNUSABLE));
  const text = venueEvidence(out)[0].summary;
  assert.match(text, /Untappd 评分 4\.61603/);
  assert.match(text, /527 人评分/);
  assert.match(text, /ABV 12\.5%/);
});

// ── menuIndex / number-only linking ──

test("a number-like name and menuIndex equal to an event_beer_id never link alone", () => {
  const byNumber = candidate({ displayName: "498", brewery: "Mikkeller", menuIndex: 498 });
  assert.equal(getGrounding(ground(byNumber)), null, "bare number is not a beer identity");

  const byIndex = candidate({ displayName: "Starboy", brewery: "Honey Pot", menuIndex: 93 });
  assert.equal(getGrounding(ground(byIndex))?.eventBeerId, 305);
});

// ── aliases ──

test("exact alias grounds (#424 Rosemary's Baby) and OCR display name is preserved", () => {
  const input = candidate({
    displayName: "Rosemary's Baby",
    brewery: "Adroit Theory",
    style: "Sour Ale",
  });
  const out = ground(input);
  assert.equal(getGrounding(out)?.eventBeerId, 424);
  assert.equal(out.displayName, "Rosemary's Baby", "OCR name preserved, not renamed to catalog name");
  assert.equal(out.style, "Gose", "known catalog style supersedes OCR guess on unique identity");
  assert.equal(out.abv, 4.5);
  const text = venueEvidence(out)[0].summary;
  assert.match(text, /Adroit Theory/);
});

test("alias without brewery stays unique-grounds only when alias unique; wrong brewery rejects", () => {
  const wrong = candidate({ displayName: "Rosemary's Baby", brewery: "Other Brewery" });
  assert.equal(getGrounding(ground(wrong)), null);
});

// ── OCR explicit ABV conflict ──

test("OCR explicit ABV disagreement keeps conflict evidence and flags uncertainty", () => {
  const input = candidate({
    displayName: "Starboy",
    brewery: "Honey Pot",
    abv: 8,
    evidence: [
      { source: "ocr", confidence: 0.7, summary: "poster text" },
      ocrExplicitAbvEvidence(8, 0.7),
    ],
  });
  const out = ground(input);
  assert.equal(out.abv, 12.5, "catalog value is used");
  assert.ok(out.riskFlags.includes(RISK_EVENT_ABV_CONFLICT));
  const all = out.evidence.map(e => e.summary).join("\n");
  assert.match(all, /8(?:\.0)?%/, "OCR 8% claim preserved as conflict evidence");
  assert.match(all, /12\.5%/, "catalog 12.5% recorded");
  const venue = venueEvidence(out)[0];
  assert.ok(venue.confidence < 0.9, "confidence reduced to prevent false certainty");
});

test("OCR ABV equal to catalog adds no conflict; stale ABV difference without OCR claim supersedes silently", () => {
  const agreeing = candidate({
    displayName: "Starboy",
    brewery: "Honey Pot",
    abv: 12.5,
    evidence: [ocrExplicitAbvEvidence(12.5, 0.8)],
  });
  const ok = ground(agreeing);
  assert.ok(!ok.riskFlags.includes(RISK_EVENT_ABV_CONFLICT));

  const staleOnly = candidate({ displayName: "Starboy", brewery: "Honey Pot", abv: 8 });
  const silenced = ground(staleOnly);
  assert.equal(silenced.abv, 12.5);
  assert.ok(!silenced.riskFlags.includes(RISK_EVENT_ABV_CONFLICT));
});

test("OCR ABV claim on a catalog row with null ABV is kept as unconfirmed evidence, abv stays 0", () => {
  const input = candidate({
    displayName: "Bohemian Machine",
    brewery: "Budvar",
    abv: 5,
    evidence: [ocrExplicitAbvEvidence(5, 0.6)],
  });
  const out = ground(input);
  assert.equal(out.abv, 0);
  assert.ok(out.riskFlags.includes(RISK_EVENT_ABV_UNKNOWN));
  const text = venueEvidence(out)[0].summary;
  assert.match(text, /OCR 菜单明示 5%/);
  assert.match(text, /未经酒单确认|未标注/);
});

// ── price / OCR field preservation ──

test("grounding preserves OCR price, currency, serving, volume, menuIndex, brewery", () => {
  const input = candidate({
    displayName: "Starboy",
    brewery: "Honey Pot",
    price: 68,
    currency: "CNY",
    servingMode: "杯",
    volumeMl: 330,
    menuIndex: 12,
  });
  const out = ground(input);
  assert.equal(out.price, 68);
  assert.equal(out.currency, "CNY");
  assert.equal(out.servingMode, "杯");
  assert.equal(out.volumeMl, 330);
  assert.equal(out.menuIndex, 12);
  assert.equal(out.brewery, "Honey Pot");
});

// ── publisher is not authoritative brewery verification ──

test("event listing does not claim brewery verification; prior warning retained", () => {
  const input = candidate({
    displayName: "Starboy",
    brewery: "Honey Pot",
    riskFlags: ["酒厂名称未独立核验"],
  });
  const out = ground(input);
  assert.ok(out.riskFlags.includes("酒厂名称未独立核验"));
  const text = venueEvidence(out)[0].summary;
  assert.match(text, /整合活动目录列示/);
  assert.ok(!/酒厂已核验|brewery verified/i.test(text));
});

// ── description provenance: original English, source URL, date ──

test("#355 evidence carries original English description verbatim, URL and date", () => {
  const out = ground(candidate({ displayName: "Next up Volunteers", brewery: "WarPigs" }));
  assert.equal(getGrounding(out)?.eventBeerId, 355);
  const text = venueEvidence(out)[0].summary;
  assert.ok(text.includes(byId[355].description), "original English description embedded verbatim");
  assert.ok(text.includes(byId[355].source_url));
  assert.match(text, /2026-10-16/);
  assert.match(text, /#355/);
});

test("#223 catalog issues (abv_database_disagreement) surface as uncertainty", () => {
  const out = ground(candidate({ displayName: "Atom Passionfruit", brewery: "Uchu" }));
  assert.equal(getGrounding(out)?.eventBeerId, 223);
  assert.ok(out.riskFlags.some(f => f.includes("ABV") && f.includes("冲突")));
  assert.match(venueEvidence(out)[0].summary, /abv_database_disagreement/);
});

// ── purity / fail-soft behavior ──

test("groundMenuCandidates is pure and fail-soft", () => {
  const input = candidate({ displayName: "Starboy", brewery: "Honey Pot", style: "X" });
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = groundMenuCandidates([input], records)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot, "input candidate never mutated");
  assert.notEqual(out, input, "match returns a cloned candidate");

  assert.deepEqual(groundMenuCandidates([input], []), [input], "empty catalog pass-through");
  assert.deepEqual(groundMenuCandidates([input], [{ broken: true }]), [input], "all-malformed catalog pass-through");

  const unknown = candidate({ displayName: "Nope Beer", brewery: "Nowhere" });
  assert.equal(groundMenuCandidates([unknown], records)[0], unknown, "unmatched candidate untouched");
});

// ── readEventCatalog: missing / malformed / valid real fixture file ──

test("readEventCatalog fails closed on missing/malformed/non-array and parses the real fixture file", async () => {
  const cwd = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mbcb-catalog-"));
  const eventsDir = path.join(dir, "data", "events");
  const file = path.join(eventsDir, "mbcb-2026-red.json");
  try {
    process.chdir(dir);
    assert.deepEqual(await readEventCatalog(), [], "missing file -> []");

    await mkdir(eventsDir, { recursive: true });
    await writeFile(file, "{ definitely not json", "utf8");
    assert.deepEqual(await readEventCatalog(), [], "malformed JSON -> []");

    await writeFile(file, JSON.stringify({ not: "an array" }), "utf8");
    assert.deepEqual(await readEventCatalog(), [], "non-array payload -> []");

    await writeFile(
      file,
      JSON.stringify([{ broken: true }, records[1], { event_beer_id: "x", name: 12 }]),
      "utf8",
    );
    const filtered = await readEventCatalog();
    assert.equal(filtered.length, 1, "individual malformed rows are filtered, valid rows survive");
    assert.equal(filtered[0].event_beer_id, 305);

    await writeFile(file, fixtureRaw, "utf8");
    const loaded = await readEventCatalog();
    assert.equal(loaded.length, records.length);
    assert.equal(loaded[4].event_beer_id, 96);
    assert.equal(loaded[5].event_beer_id, 93);
    assert.equal(loaded[6].event_beer_id, 498);

    // End-to-end through the real reader: 498 grounding works on file-loaded records.
    const out = groundMenuCandidates(
      [candidate({ displayName: "Mikkeller Ice Tea Powered by Longfong", brewery: "Mikkeller", abv: 1 })],
      loaded,
    )[0];
    assert.equal(out.abv, 7.5);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});
