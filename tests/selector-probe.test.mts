import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PROBE_TARGETS,
  cssToRegex,
  detectDrift,
  runProbe,
} from "../lib/crawler/selector-probe.ts";

const FIXTURE_DIR = new URL(
  "../data/crawler/_fixtures/",
  import.meta.url,
);

async function load(name: string): Promise<string> {
  return await readFile(new URL(name, FIXTURE_DIR), "utf8");
}

const top = await load("untappd-top.html");
const detail = await load("untappd-detail-info.html");
const rbList = await load("ratebeer-cn-list.html");
const rbDetail = await load("ratebeer-detail-cn.html");

// ── 1. ProbeTarget enumeration is stable + covers both sources ───────────

test("PROBE_TARGETS covers untappd LIST_SELECTORS entirely", () => {
  const untappdList = PROBE_TARGETS.filter(
    (t) => t.source === "untappd" && t.surface === "list",
  );
  const names = untappdList.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "LIST_SELECTORS.id",
    "LIST_SELECTORS.item",
    "LIST_SELECTORS.name",
    "LIST_SELECTORS.url",
  ]);
});

test("PROBE_TARGETS covers untappd DETAIL_SELECTORS entirely", () => {
  const untappdDetail = PROBE_TARGETS.filter(
    (t) => t.source === "untappd" && t.surface === "detail",
  );
  const names = untappdDetail.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "DETAIL_SELECTORS.food",
    "DETAIL_SELECTORS.info",
    "DETAIL_SELECTORS.ratings",
    "DETAIL_SELECTORS.similar",
    "DETAIL_SELECTORS.tags",
  ]);
});

test("PROBE_TARGETS covers every ratebeer *_RE selector", () => {
  const names = PROBE_TARGETS.filter((t) => t.source === "ratebeer").map(
    (t) => t.name,
  );
  for (const expected of [
    "LIST_BEER_LINK_RE",
    "DETAIL_NAME_RE",
    "DETAIL_RATING_RE",
    "DETAIL_RATING_COUNT_RE",
    "DETAIL_ABV_RE",
    "DETAIL_STYLE_RE",
    "DETAIL_BREWERY_RE",
  ]) {
    assert.ok(names.includes(expected), `missing ratebeer probe: ${expected}`);
  }
});

// ── 2. runProbe — untappd list fixture (5 beer items) ─────────────────────

test("runProbe(untappd, list) finds all 5 list items + per-field matches", () => {
  const results = runProbe(top, "untappd", "list");
  const itemResult = results.find((r) => r.id === "untappd.list.item");
  const idResult = results.find((r) => r.id === "untappd.list.id");
  const nameResult = results.find((r) => r.id === "untappd.list.name");
  const urlResult = results.find((r) => r.id === "untappd.list.url");

  assert.ok(itemResult, "untappd.list.item probe missing");
  assert.ok(idResult, "untappd.list.id probe missing");
  assert.ok(nameResult, "untappd.list.name probe missing");
  assert.ok(urlResult, "untappd.list.url probe missing");

  assert.equal(itemResult!.matched, 5, "list items = 5 divs");
  assert.equal(idResult!.matched, 5, "data-beer-id attrs = 5");
  assert.equal(nameResult!.matched, 5, ".beer-name anchors = 5");
  assert.equal(urlResult!.matched, 5, "/beer/ hrefs = 5");

  // Sample snippets should be non-empty strings.
  for (const r of [itemResult!, idResult!, nameResult!, urlResult!]) {
    assert.ok(r.sample.length > 0, `${r.id} returned no samples`);
    for (const s of r.sample) assert.ok(s.length > 0);
  }
});

// ── 3. runProbe — untappd detail fixture (info tab) ──────────────────────

test("runProbe(untappd, detail) detects all 5 tab markers in info fixture", () => {
  const results = runProbe(detail, "untappd", "detail");
  for (const id of [
    "untappd.detail.info",
    "untappd.detail.ratings",
    "untappd.detail.tags",
    "untappd.detail.food",
    "untappd.detail.similar",
  ]) {
    const r = results.find((x) => x.id === id);
    assert.ok(r, `${id} probe missing`);
    // The fixture contains exactly one matching element per tab.
    assert.ok(r!.matched >= 1, `${id} should match ≥1 element`);
  }
});

// ── 4. runProbe — ratebeer fixture probes ────────────────────────────────

test("runProbe(ratebeer, list) matches all 5 list beer links", () => {
  const results = runProbe(rbList, "ratebeer", "list");
  const r = results.find((x) => x.id === "ratebeer.list.beer-link");
  assert.ok(r);
  assert.equal(r!.matched, 5);
});

test("runProbe(ratebeer, detail) matches every detail regex against the cn fixture", () => {
  const results = runProbe(rbDetail, "ratebeer", "detail");
  const byId = new Map(results.map((r) => [r.id, r]));
  // cn fixture has: name (h1), rating (.number), count (With N ratings),
  // abv (ABV: 6.5%), style, brewery — every regex should match at least 1.
  for (const id of [
    "ratebeer.detail.name",
    "ratebeer.detail.rating",
    "ratebeer.detail.rating-count",
    "ratebeer.detail.abv",
    "ratebeer.detail.style",
    "ratebeer.detail.brewery",
  ]) {
    const r = byId.get(id);
    assert.ok(r, `${id} probe missing`);
    assert.ok(r!.matched >= 1, `${id} should match ≥1 element`);
  }
});

// ── 5. Empty HTML returns matched=0 (graceful) ───────────────────────────

test("runProbe with empty HTML returns matched=0 for every target", () => {
  for (const [source, surface] of [
    ["untappd", "list"],
    ["untappd", "detail"],
    ["ratebeer", "list"],
    ["ratebeer", "detail"],
  ] as const) {
    const results = runProbe("", source, surface);
    assert.ok(results.length > 0, `${source}/${surface} returned no probes`);
    for (const r of results) {
      assert.equal(r.matched, 0, `${r.id} should have matched=0`);
      assert.deepEqual(r.sample, []);
    }
  }
});

// ── 6. CSS→regex helper: class + attr + comma alternate ─────────────────

test("cssToRegex handles .class, [attr=\"value\"], [attr*=\"v\"], and comma alternation", () => {
  const html = `
    <div data-beer-id="1"><a class="beer-name" href="/beer/one">One</a></div>
    <div data-beer-id="2"><a class="name" href="/beer/two">Two</a></div>
  `;
  const re = cssToRegex('.beer-name, .name');
  const matches = [...html.matchAll(re)].map((m) => m[0]);
  assert.equal(matches.length, 2);
  assert.ok(matches[0]!.includes("beer-name"));

  const hrefRe = cssToRegex('a[href*="/beer/"]');
  const hrefMatches = [...html.matchAll(hrefRe)].map((m) => m[0]);
  assert.equal(hrefMatches.length, 2);

  const tabRe = cssToRegex('[data-tab="info"]');
  const tabMatch = `<section data-tab="info">hello</section>`.match(tabRe);
  assert.ok(tabMatch);
});

// ── 7. detectDrift: 100% drop is reported ────────────────────────────────

test("detectDrift flags a target that drops from 5 to 0 matches", () => {
  const baseline = [
    { id: "x", source: "untappd" as const, surface: "list" as const, name: "n", matched: 5, sample: [] },
  ];
  const latest = [
    { id: "x", source: "untappd" as const, surface: "list" as const, name: "n", matched: 0, sample: [] },
  ];
  const drifts = detectDrift(baseline, latest);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]!.latest_matched, 0);
  assert.equal(drifts[0]!.baseline_matched, 5);
  assert.equal(drifts[0]!.delta_ratio, 1);
  assert.equal(drifts[0]!.drift, true);
});

// ── 8. detectDrift: small variance is ignored ────────────────────────────

test("detectDrift ignores ≤20% variance", () => {
  const baseline = [
    { id: "x", source: "untappd" as const, surface: "list" as const, name: "n", matched: 10, sample: [] },
  ];
  // 12 vs 10 = 20% exactly — should NOT trigger (strict >).
  const latest = [
    { id: "x", source: "untappd" as const, surface: "list" as const, name: "n", matched: 12, sample: [] },
  ];
  assert.deepEqual(detectDrift(baseline, latest), []);
});

// ── 9. detectDrift: >20% drop triggers ───────────────────────────────────

test("detectDrift triggers when match count drops more than 20%", () => {
  const baseline = [
    { id: "x", source: "ratebeer" as const, surface: "detail" as const, name: "n", matched: 10, sample: [] },
  ];
  // 5 vs 10 = 50% drop — must trigger.
  const latest = [
    { id: "x", source: "ratebeer" as const, surface: "detail" as const, name: "n", matched: 5, sample: [] },
  ];
  const drifts = detectDrift(baseline, latest);
  assert.equal(drifts.length, 1);
  assert.ok(drifts[0]!.delta_ratio > 0.20);
});