import test from "node:test";
import assert from "node:assert/strict";
import { parseAndRepairJson } from "../lib/beer-agent/multi-stage-pipeline.ts";

test("a vision response truncated inside the last row keeps the parsed rows", () => {
  const truncated = '{"imageContext":{"imageType":"tap_list"},"extracted":{"sourceType":"tap_list","items":[{"menuIndex":1,"beerName":"Alpha","price":60,"serving":"425ml"},{"menuIndex":2,"beerName":"Beta","price":55,"serving":"425ml","rawText":"truncated mid';
  const parsed = parseAndRepairJson(truncated, "test_vision") as any;
  const items = parsed?.extracted?.items;
  assert.ok(Array.isArray(items), "salvage must produce an items array");
  assert.ok(items.length >= 1, `expected at least one parsed row, got ${items?.length}`);
  assert.equal(items[0].beerName, "Alpha");
});

test("a complete fenced JSON object still parses without salvage", () => {
  const fenced = "```json\n{\"extracted\":{\"items\":[{\"beerName\":\"Alpha\"}]}}\n```";
  const parsed = parseAndRepairJson(fenced, "test_fenced") as any;
  assert.equal(parsed.extracted.items[0].beerName, "Alpha");
});
