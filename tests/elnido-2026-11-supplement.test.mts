import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readMenuSupplements, groundMenuSupplements } from "../lib/beer-agent/menu-supplements.ts";
import { buildBeerDossier } from "../lib/beer-agent/dossier/build-dossier.ts";

const base = {
  candidateId: "ocr_1",
  menuIndex: 1,
  displayName: "合成酒款",
  brewery: "",
  style: "",
  abv: 0,
  ibu: null,
  hops: [],
  worthScore: 50,
  fitScore: 50,
  riskFlags: [],
  reason: "",
  evidence: [{ source: "ocr", confidence: 0.8, summary: "menu row" }],
} as any;

test("the 2026-11 supplement has 13 sourced rows with ratings and dated URLs", async () => {
  const doc = JSON.parse(await readFile("data/menus/elnido-2026-11.json", "utf8"));
  assert.equal(doc.entries.length, 13);
  for (const entry of doc.entries) {
    assert.equal(entry.identity_status, "confirmed");
    assert.ok(entry.sources.length >= 1);
    assert.ok(entry.sources.some(source => /^https:\/\/untappd\.com\/b\//.test(source.url)));
    assert.match(entry.rating.url, /^https:\/\/untappd\.com\/b\//);
    assert.ok(entry.rating.score >= 0 && entry.rating.score <= 5);
    assert.ok(entry.rating.count > 0);
    assert.match(entry.rating.checked_at, /^2026-11-15/);
  }
  const all = await readMenuSupplements();
  assert.equal(all.filter(entry => entry.menu_id === "elnido-2026-11").length, 13);
});

test("OCR brewery misreads are replaced by the sourced brewery and rating", async () => {
  const entries = await readMenuSupplements();
  const candidate = { ...base, menuIndex: 7, displayName: "沉浸浸酿 浑浊IPA", brewery: "Other Half", style: "浑浊 IPA", abv: 6.7 };
  const grounded = groundMenuSupplements([candidate], entries)[0];
  assert.equal(grounded.brewery, "Outer Range Brewing Co.");
  assert.equal(grounded.style, "IPA - New England / Hazy");
  const dossier = buildBeerDossier(grounded, entries);
  assert.equal(dossier.identity.identityStatus, "confirmed");
  assert.ok(dossier.rating);
  assert.equal(dossier.rating.value.score, 4.09037);
  assert.equal(dossier.rating.value.count, 37286);
  assert.equal(dossier.rating.url, "https://untappd.com/b/outer-range-brewing-co-in-the-steep/2002572");
  assert.deepEqual(dossier.hops?.value, ["Citra"]);
});

test("menu/source ABV conflicts are preserved instead of silently choosing one", async () => {
  const entries = await readMenuSupplements();
  const candidate = { ...base, menuIndex: 5, displayName: "野花 冷萃鲜酿2号 浑浊IPA", brewery: "Ebbzart", style: "浑浊IPA", abv: 7.5 };
  const grounded = groundMenuSupplements([candidate], entries)[0];
  const dossier = buildBeerDossier(grounded, entries);
  assert.equal(dossier.abv.conflicted, true);
  assert.deepEqual(dossier.abv.observations.map(observation => observation.value).sort(), [5.9, 7.5]);
});
