/**
 * Golden set schema + coverage validation for the beer-menu-advisor menu
 * test set (tests/golden/menu-golden-set.json).
 *
 * This test does NOT run the pipeline — the e2e runner plugs in at P0
 * (single runBeerDecision() entry). It enforces:
 *
 *   1. The dataset parses and has the required meta block.
 *   2. Every case has a valid shape (input/expected/status/confidence).
 *   3. All 10 required scenario categories are covered.
 *   4. Constraint expectations are structurally valid (maxPrice number,
 *      bitterness enum, pick assertions reference real menu rawText).
 *
 * Run via: node --experimental-strip-types --test tests/golden-set.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(
  readFileSync(path.join(here, "golden", "menu-golden-set.json"), "utf8"),
) as {
  meta: {
    schemaVersion: number;
    requiredCategories: string[];
  };
  cases: GoldenCase[];
};

interface ResolvedItem {
  rawText: string;
  beer?: string | null;
  brewery?: string;
  style?: string;
  abv?: number;
  price?: number;
  volumeMl?: number;
  entityConfidence: number;
  uncertain: boolean;
}

interface GoldenCase {
  id: string;
  category: string;
  status: "ready" | "needs-fixture";
  locale: string;
  input: {
    menuText?: string | null;
    imagePath?: string | null;
    userConstraints: string[];
  };
  expected: {
    resolvedItems: ResolvedItem[];
    constraints?: {
      maxPrice?: number;
      currency?: string;
      maxAbv?: number;
      bitterness?: "low" | "medium" | "high";
      occasion?: string;
      novelty?: string;
    };
    forbiddenPicks?: Record<string, string[]>;
    allowedPicks?: Record<string, string[]>;
    expectedMetrics?: Record<string, number>;
    flags?: Record<string, boolean>;
    notes?: string;
  };
}

const PICK_SLOTS = ["top", "safe", "explore", "caution"];

describe("menu golden set schema", () => {
  it("has the required meta block", () => {
    assert.equal(dataset.meta.schemaVersion, 1);
    assert.ok(dataset.meta.requiredCategories.length >= 10);
  });

  it("case ids are unique", () => {
    const ids = dataset.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("every case has a valid shape", () => {
    for (const c of dataset.cases) {
      assert.match(c.id, /^g\d{3}$/, `bad id: ${c.id}`);
      assert.ok(["ready", "needs-fixture"].includes(c.status), `${c.id} bad status`);
      assert.ok(c.locale, `${c.id} missing locale`);
      assert.ok(Array.isArray(c.input.userConstraints), `${c.id} userConstraints`);
      const hasMenuText = typeof c.input.menuText === "string" && c.input.menuText.length > 0;
      const hasImage = typeof c.input.imagePath === "string" && c.input.imagePath.length > 0;
      assert.ok(hasMenuText || hasImage || c.status === "needs-fixture", `${c.id} no input`);
      for (const item of c.expected.resolvedItems) {
        assert.ok(item.rawText.length > 0, `${c.id} item missing rawText`);
        assert.ok(item.entityConfidence >= 0 && item.entityConfidence <= 1, `${c.id} bad confidence`);
        assert.equal(typeof item.uncertain, "boolean", `${c.id} uncertain not boolean`);
      }
      if (c.status === "ready") {
        assert.ok(c.expected.resolvedItems.length > 0, `${c.id} ready but no expected items`);
      }
    }
  });

  it("covers all 10 required categories", () => {
    const covered = new Set(dataset.cases.map((c) => c.category));
    const missing = dataset.meta.requiredCategories.filter((cat) => !covered.has(cat));
    assert.deepEqual(missing, [], `missing categories: ${missing.join(", ")}`);
  });

  it("constraint expectations are structurally valid", () => {
    for (const c of dataset.cases) {
      const cons = c.expected.constraints;
      if (!cons) continue;
      if (cons.maxPrice != null) {
        assert.equal(typeof cons.maxPrice, "number", `${c.id} maxPrice not number`);
        assert.equal(cons.currency, "CNY", `${c.id} currency missing`);
      }
      if (cons.maxAbv != null) assert.equal(typeof cons.maxAbv, "number", `${c.id} maxAbv`);
      if (cons.bitterness != null) {
        assert.ok(["low", "medium", "high"].includes(cons.bitterness), `${c.id} bitterness enum`);
      }
      if (cons.occasion != null) assert.equal(cons.occasion, "first_beer", `${c.id} occasion`);
      if (cons.novelty != null) assert.equal(cons.novelty, "explore", `${c.id} novelty`);
    }
  });

  it("pick assertions only reference real menu rawText and valid slots", () => {
    // Pick assertions name candidates by their display name (a shortened
    // form of the menu line), so match as a substring of rawText.
    const matchesMenu = (c: GoldenCase, name: string) =>
      c.expected.resolvedItems.some((i) => i.rawText.includes(name));
    for (const c of dataset.cases) {
      for (const [slot, names] of Object.entries(c.expected.forbiddenPicks ?? {})) {
        assert.ok(PICK_SLOTS.includes(slot), `${c.id} bad slot ${slot}`);
        for (const name of names) assert.ok(matchesMenu(c, name), `${c.id} forbiddenPick ${name} not in menu`);
      }
      for (const [slot, names] of Object.entries(c.expected.allowedPicks ?? {})) {
        assert.ok(PICK_SLOTS.includes(slot), `${c.id} bad slot ${slot}`);
        for (const name of names) assert.ok(matchesMenu(c, name), `${c.id} allowedPick ${name} not in menu`);
      }
    }
  });

  it("every case cites at least one core metric", () => {
    for (const c of dataset.cases) {
      assert.ok(
        c.expected.expectedMetrics && Object.keys(c.expected.expectedMetrics).length > 0,
        `${c.id} missing expectedMetrics`,
      );
    }
  });

  it("prints the coverage summary", () => {
    const byCategory = new Map<string, string[]>();
    for (const c of dataset.cases) {
      const list = byCategory.get(c.category) ?? [];
      list.push(c.id);
      byCategory.set(c.category, list);
    }
    const ready = dataset.cases.filter((c) => c.status === "ready").length;
    console.log(
      `\ngolden-set: ${dataset.cases.length} cases / ${ready} ready / ` +
        `${dataset.cases.length - ready} needs-fixture / categories: ` +
        [...byCategory.entries()].map(([cat, ids]) => `${cat}(${ids.join(",")})`).join(" "),
    );
  });
});
