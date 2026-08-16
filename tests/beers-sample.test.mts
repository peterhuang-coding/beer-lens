/**
 * tests/beers-sample.test.mts
 *
 * Unit tests for app/beers/_lib/sample.ts pure helpers.
 * Does NOT touch the filesystem — uses fixture strings only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonlLines,
  mergeRecordMeta,
  pickRandom,
  type SampledBeer,
} from "../app/beers/_lib/sample.ts";

// ── parseJsonlLines ────────────────────────────────────────────────────────

test("parseJsonlLines: splits record / meta by __meta flag", () => {
  const fixture = [
    JSON.stringify({
      source_id: "1",
      name: "Beer A",
      style: "IPA",
      abv: 6.0,
      rating: 4.0,
      rating_count: 100,
      url: "https://untappd.com/b/1",
    }),
    JSON.stringify({ __meta: true, source_id: "1", country: "Japan", brewery_name: "Brew A" }),
    JSON.stringify({
      source_id: "2",
      name: "Beer B",
      style: null,
      abv: 5.0,
      rating: 3.5,
      rating_count: 50,
      url: "https://untappd.com/b/2",
    }),
    JSON.stringify({ __meta: true, source_id: "2", country: "England", brewery_name: "Brew B" }),
  ].join("\n");

  const lines = parseJsonlLines(fixture);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].kind, "record");
  assert.equal(lines[1].kind, "meta");
  assert.equal(lines[2].kind, "record");
  assert.equal(lines[3].kind, "meta");
});

test("parseJsonlLines: skips blank and malformed lines silently", () => {
  const fixture = [
    "{not valid json",
    "",
    JSON.stringify({ source_id: "1", name: "OK", url: "" }),
    "  ",
  ].join("\n");

  const lines = parseJsonlLines(fixture);
  // Only the one valid line survives
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "record");
  assert.equal((lines[0].data as { name: string }).name, "OK");
});

// ── mergeRecordMeta ────────────────────────────────────────────────────────

test("mergeRecordMeta: pairs records with meta by source_id", () => {
  const lines = parseJsonlLines(
    [
      JSON.stringify({ source_id: "1", name: "A", style: "IPA", abv: 6, rating: 4, rating_count: 100, url: "u1" }),
      JSON.stringify({ __meta: true, source_id: "1", country: "Japan", brewery_name: "BrewA" }),
      JSON.stringify({ source_id: "2", name: "B", style: null, abv: 5, rating: 3.5, rating_count: 50, url: "u2" }),
      JSON.stringify({ __meta: true, source_id: "2", country: "England", brewery_name: "BrewB" }),
    ].join("\n"),
  );

  const merged = mergeRecordMeta(lines);
  assert.equal(merged.length, 2);

  const a = merged.find((b) => b.source_id === "1")!;
  assert.equal(a.name, "A");
  assert.equal(a.style, "IPA");
  assert.equal(a.country, "Japan");
  assert.equal(a.brewery_name, "BrewA");
  assert.equal(a.abv, 6);
  assert.equal(a.rating, 4);
  assert.equal(a.rating_count, 100);

  const b = merged.find((b) => b.source_id === "2")!;
  assert.equal(b.style, null);
  assert.equal(b.country, "England");
  assert.equal(b.brewery_name, "BrewB");
});

test("mergeRecordMeta: handles record without matching meta (country=null, brewery_name=null)", () => {
  const lines = parseJsonlLines(
    [
      JSON.stringify({ source_id: "99", name: "Orphan", style: "Stout", abv: 7, rating: 4.2, rating_count: 200, url: "u99" }),
    ].join("\n"),
  );
  const merged = mergeRecordMeta(lines);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source_id, "99");
  assert.equal(merged[0].country, null);
  assert.equal(merged[0].brewery_name, null);
});

test("mergeRecordMeta: coerces non-numeric abv/rating to null", () => {
  const lines = parseJsonlLines(
    [
      JSON.stringify({ source_id: "1", name: "Weird", style: "X", abv: "abc", rating: null, rating_count: undefined, url: "" }),
      JSON.stringify({ __meta: true, source_id: "1", country: "Japan", brewery_name: "B" }),
    ].join("\n"),
  );
  const merged = mergeRecordMeta(lines);
  assert.equal(merged[0].abv, null);
  assert.equal(merged[0].rating, null);
  // rating_count: undefined → null per typeof check
  assert.equal(merged[0].rating_count, null);
});

// ── pickRandom ─────────────────────────────────────────────────────────────

test("pickRandom: returns n distinct elements", () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const sample = pickRandom(arr, 5);
  assert.equal(sample.length, 5);
  // All unique
  assert.equal(new Set(sample).size, 5);
  // All from input
  for (const x of sample) assert.ok(arr.includes(x));
});

test("pickRandom: n > arr.length returns at most arr.length", () => {
  const sample = pickRandom([1, 2, 3], 100);
  assert.equal(sample.length, 3);
  assert.equal(new Set(sample).size, 3);
});

test("pickRandom: n=0 or n<0 returns []", () => {
  assert.deepEqual(pickRandom([1, 2, 3], 0), []);
  assert.deepEqual(pickRandom([1, 2, 3], -5), []);
});

test("pickRandom: does not mutate input", () => {
  const arr = [1, 2, 3, 4, 5];
  const snapshot = arr.slice();
  pickRandom(arr, 3);
  assert.deepEqual(arr, snapshot);
});

test("pickRandom: empty input returns []", () => {
  assert.deepEqual(pickRandom([], 5), []);
});

// ── end-to-end: parse + merge + pick (without filesystem) ─────────────────

test("e2e: parses 4-line fixture → 2 beers → pick 2 → returns both", () => {
  const fixture = [
    JSON.stringify({ source_id: "1", name: "Alpha", style: "IPA", abv: 6, rating: 4, rating_count: 100, url: "u1" }),
    JSON.stringify({ __meta: true, source_id: "1", country: "Japan", brewery_name: "BrewA" }),
    JSON.stringify({ source_id: "2", name: "Beta", style: "Stout", abv: 7, rating: 4.5, rating_count: 200, url: "u2" }),
    JSON.stringify({ __meta: true, source_id: "2", country: "England", brewery_name: "BrewB" }),
  ].join("\n");

  const merged: SampledBeer[] = mergeRecordMeta(parseJsonlLines(fixture));
  assert.equal(merged.length, 2);

  const sample = pickRandom(merged, 2);
  assert.equal(sample.length, 2);
  const ids = sample.map((b) => b.source_id).sort();
  assert.deepEqual(ids, ["1", "2"]);
});
