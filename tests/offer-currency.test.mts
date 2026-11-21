import test from "node:test";
import assert from "node:assert/strict";
import { offerText } from "../lib/beer-agent/recommendation/purchase.ts";

const base = {
  menuIndex: 7,
  displayName: "Kölsch",
  price: 55,
  volumeMl: 425,
  currency: "unknown",
  evidence: [{ source: "ocr", summary: "7 Kölsch 4.8% 425ml ¥55" }],
} as any;

test("an OCR unknown currency is displayed from the visible ¥ symbol", () => {
  assert.equal(offerText(base), "55元 / 425ml，12.94元/100ml");
});

test("without any visible currency symbol the label stays explicitly unknown", () => {
  const noEvidence = { ...base, evidence: [] };
  assert.equal(offerText(noEvidence), "55（币种未知） / 425ml，12.94（币种未知）/100ml");
});

test("a real non-CNY code is preserved", () => {
  assert.equal(offerText({ ...base, currency: "USD" }), "55 USD / 425ml，12.94 USD/100ml");
});
