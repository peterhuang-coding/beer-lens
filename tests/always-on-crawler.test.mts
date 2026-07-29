/**
 * Tests for the always-on-crawler pure helpers (scripts/always-on-crawler-lib.mjs).
 *
 * Run via: node --experimental-strip-types --test tests/always-on-crawler.test.mts
 *
 * No subprocess spawning — these are pure-logic tests against the lib module.
 */

// @ts-nocheck — strip-types module resolution tolerates untyped this
import { describe, it } from "node:test";
import assert from "node:assert";

import {
  dedupeAndMerge,
  filterByBrewery,
  filterByCountry,
  shapeOutput,
} from "../scripts/always-on-crawler-lib.mjs";

describe("dedupeAndMerge", () => {
  it("preserves priority order: gaps → user → seeds", () => {
    const gaps = [{ name: "Sleep", brewery: "HopFan", priority: "p0_gap" }];
    const user = [{ name: "Custom IPA", brewery: "Some Brewery", priority: "p1_user" }];
    const seeds = [{ name: "Flying Fist", brewery: "Jing-A", priority: "p2_seed" }];
    const out = dedupeAndMerge({ gaps, user, seeds }, 30);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].name, "Sleep");
    assert.strictEqual(out[1].name, "Custom IPA");
    assert.strictEqual(out[2].name, "Flying Fist");
  });

  it("dedupes case-insensitively on (name, brewery)", () => {
    const gaps = [{ name: "Sleep", brewery: "HopFan", priority: "p0_gap" }];
    const seeds = [{ name: "SLEEP", brewery: "hopfan", priority: "p2_seed" }];
    const out = dedupeAndMerge({ gaps, user: [], seeds }, 30);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].priority, "p0_gap", "earlier priority wins");
  });

  it("respects the limit cap", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      name: `Beer ${i}`,
      brewery: `Brewery ${i}`,
      priority: "p2_seed",
    }));
    const out = dedupeAndMerge({ gaps: [], user: [], seeds: items }, 10);
    assert.strictEqual(out.length, 10);
  });

  it("skips items missing name or brewery", () => {
    const bad = [
      { name: "", brewery: "X" },
      { name: "OK", brewery: "" },
      { name: "Real", brewery: "Real" },
    ];
    const out = dedupeAndMerge({ gaps: bad, user: [], seeds: [] }, 30);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, "Real");
  });

  it("returns [] for empty inputs", () => {
    assert.deepStrictEqual(dedupeAndMerge({ gaps: [], user: [], seeds: [] }, 30), []);
  });

  it("treats limit=0 as zero-cap (returns [])", () => {
    const items = [{ name: "A", brewery: "B", priority: "p0_gap" }];
    assert.deepStrictEqual(dedupeAndMerge({ gaps: items, user: [], seeds: [] }, 0), []);
  });
});

describe("filterByBrewery", () => {
  const beers = [
    { name: "Flying Fist IPA", brewery: "Jing-A (京A) Brewing Co." },
    { name: "Mandarin Wheat", brewery: "Jing-A Brewing Co." },
    { name: "Bird Land NE IPA", brewery: "Master Gao Brewing Co." },
    { name: "Pseudo Sue", brewery: "Toppling Goliath Brewing Co." },
  ];

  it("filters by brewery substring (case-insensitive)", () => {
    const out = filterByBrewery(beers, ["Jing-A"]);
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((b) => b.brewery.toLowerCase().includes("jing-a")));
  });

  it("OR-combines multiple brewery needles", () => {
    const out = filterByBrewery(beers, ["Jing-A", "Master Gao"]);
    assert.strictEqual(out.length, 3);
  });

  it("returns all when no brewery filter", () => {
    const out = filterByBrewery(beers, []);
    assert.strictEqual(out.length, beers.length);
  });
});

describe("filterByCountry", () => {
  const beers = [
    { name: "A", brewery: "X", country: "China" },
    { name: "B", brewery: "Y", country: "China" },
    { name: "C", brewery: "Z", country: "USA" },
    { name: "D", brewery: "W" }, // no country → default China
  ];

  it("matches explicit country strings", () => {
    const out = filterByCountry(beers, ["China"]);
    assert.strictEqual(out.length, 3); // 2 China + 1 default-China
  });

  it("matches multiple countries (OR)", () => {
    const out = filterByCountry(beers, ["China", "USA"]);
    assert.strictEqual(out.length, 4);
  });

  it("treats missing country as China", () => {
    const out = filterByCountry(beers, ["China"]);
    assert.ok(out.some((b) => b.name === "D"));
  });
});

describe("shapeOutput", () => {
  it("produces the documented envelope", () => {
    const out = shapeOutput({
      round: 1,
      limit: 30,
      filters: { breweries: ["Jing-A"], countries: ["China"] },
      gaps: [{}], // length=1
      user: [],
      seeds: [{}, {}], // length=2
      targets: [{}, {}, {}], // length=3
      generatedAt: "2026-07-29T00:00:00Z",
    });
    assert.strictEqual(out.round, 1);
    assert.strictEqual(out.limit, 30);
    assert.deepStrictEqual(out.filters, { breweries: ["Jing-A"], countries: ["China"] });
    assert.strictEqual(out.summary.p0_gaps, 1);
    assert.strictEqual(out.summary.p1_user, 0);
    assert.strictEqual(out.summary.p2_seeds, 2);
    assert.strictEqual(out.summary.total, 3);
    assert.strictEqual(out.generatedAt, "2026-07-29T00:00:00Z");
    assert.strictEqual(out.targets.length, 3);
  });

  it("defaults round to null when omitted", () => {
    const out = shapeOutput({ limit: 30, gaps: [], user: [], seeds: [], targets: [] });
    assert.strictEqual(out.round, null);
  });

  it("generates ISO timestamp when generatedAt omitted", () => {
    const out = shapeOutput({ limit: 30, gaps: [], user: [], seeds: [], targets: [] });
    assert.match(out.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});