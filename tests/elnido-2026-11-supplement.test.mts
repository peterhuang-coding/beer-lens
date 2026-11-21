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

test("the 2026-11 supplement has 16 sourced rows with ratings and dated URLs", async () => {
  const doc = JSON.parse(await readFile("data/menus/elnido-2026-11.json", "utf8"));
  assert.equal(doc.entries.length, 16);
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
  assert.equal(all.filter(entry => entry.menu_id === "elnido-2026-11").length, 16);
});

test("OCR brewery misreads are replaced by the sourced brewery and rating", async () => {
  const entries = await readMenuSupplements();
  const candidate = { ...base, menuIndex: 12, displayName: "迷你恐惧症 干投酸IPA", brewery: "Toftebo", style: "干投酸IPA", abv: 5.0 };
  const grounded = groundMenuSupplements([candidate], entries)[0];
  assert.equal(grounded.brewery, "Totopia Brewery");
  assert.equal(grounded.style, "IPA - Sour");
  const dossier = buildBeerDossier(grounded, entries);
  assert.equal(dossier.identity.identityStatus, "confirmed");
  assert.ok(dossier.rating);
  assert.equal(dossier.rating.value.score, 3.80489);
  assert.equal(dossier.rating.value.count, 235);
  assert.equal(dossier.rating.url, "https://untappd.com/b/totopia-brewery-tinyphobia/6850762");
  assert.deepEqual(dossier.hops?.value, ["Citra"]);
});


test("a version-unresolved supplement entry never exposes its curated rating", async () => {
  const doc = JSON.parse(await readFile("data/menus/elnido-2026-11.json", "utf8"));
  const entry = { ...doc.entries[0], identity_status: "version_unresolved" };
  const candidate = {
    ...base, menuIndex: entry.menu_index,
    displayName: entry.menu_name, brewery: entry.brewery,
    style: entry.style, abv: entry.observation.abv,
  };
  const grounded = groundMenuSupplements([candidate], [entry])[0];
  const dossier = buildBeerDossier(grounded, [entry]);
  assert.equal(dossier.identity.identityStatus, "version_unresolved");
  assert.equal(dossier.rating, null);
});

test("menu/source ABV conflicts are preserved instead of silently choosing one", async () => {
  const entries = await readMenuSupplements();
  const candidate = { ...base, menuIndex: 12, displayName: "迷你恐惧症 干投酸IPA", brewery: "Toftebo", style: "干投酸IPA", abv: 5.0 };
  const grounded = groundMenuSupplements([candidate], entries)[0];
  const dossier = buildBeerDossier(grounded, entries);
  assert.equal(dossier.abv.conflicted, true);
  assert.deepEqual(dossier.abv.observations.map(observation => observation.value).sort(), [5.0, 6.0]);
});
