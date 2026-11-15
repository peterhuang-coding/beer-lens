import test from "node:test";
import assert from "node:assert/strict";
import { applyMenuEvidenceGuards } from "../lib/skills/beer-knowledge/evidence-guards.ts";

const memory = {
  lastMenu: {
    candidates: [
      { menuIndex: 1, displayName: "Your Young Lordship", price: 60, volumeMl: 425 },
      { menuIndex: 7, displayName: "Kölsch", price: 55, volumeMl: 425 },
      { menuIndex: 2, displayName: "The Premium Malt's Black", price: 65, volumeMl: 300 },
    ],
  },
};

test("a false lowest-price claim is corrected with the actual menu arithmetic", () => {
  const reply = "性价比优势：在17款中是单价最低的（14.12元/100ml）。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.match(guarded, /【菜单算术核对】/);
  assert.match(guarded, /#7 Kölsch/);
  assert.match(guarded, /12\.94元\/100ml/);
  assert.match(guarded, /不等于最低价/);
  assert.ok(guarded.includes(reply), "the model's prose is preserved after the correction");
});

test("a correct cheapest claim still gets the deterministic arithmetic line", () => {
  const reply = "Kölsch 是菜单里性价比最高的。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.match(guarded, /【菜单算术核对】/);
  assert.match(guarded, /#7 Kölsch/);
});

test("unsourced brewery history is explicitly caveated", () => {
  const reply = "Gaffel 是德国百年老牌酒厂，生产正宗 Kölsch。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.match(guarded, /【来源核对】/);
  assert.match(guarded, /没有提供酒厂历史/);
});

test("sourced brewery reputation suppresses the source caveat", () => {
  const sourced = {
    lastMenu: {
      candidates: [{
        menuIndex: 7,
        displayName: "Kölsch",
        dossier: { brewery: { reputation: [{ value: { kind: "classic", text: "酒厂自述经典" } }] } },
      }],
    },
  };
  const guarded = applyMenuEvidenceGuards("Gaffel 是百年老牌。", sourced);
  assert.doesNotMatch(guarded, /【来源核对】/);
});

test("an in-budget beer cannot be described as over budget", () => {
  const budgetMemory = {
    currentConstraints: ["maxPrice:100"],
    lastMenu: {
      candidates: [
        { menuIndex: 3, displayName: "Cyber Sue", price: 85, volumeMl: 425 },
        { menuIndex: 4, displayName: "DDH Pseudo Sue", price: 90, volumeMl: 425 },
        { menuIndex: 6, displayName: "Cool Cool", price: 90, volumeMl: 300 },
        { menuIndex: 8, displayName: "Chubbles", price: 130, volumeMl: 300 },
      ],
    },
  };
  const reply = "#4 DDH Pseudo Sue 略超预算；#6 Cool Cool 略超预算；#8 Chubbles 超预算。";
  const guarded = applyMenuEvidenceGuards(reply, budgetMemory);
  assert.match(guarded, /【预算核对】/);
  assert.match(guarded, /#4 DDH Pseudo Sue（90元）/);
  assert.match(guarded, /#6 Cool Cool（90元）/);
  assert.match(guarded, /均在预算内/);
  assert.match(guarded, /超预算的是 #8 Chubbles（130元）/);
});

test("ordinary evidence-safe replies and missing memory are unchanged", () => {
  const reply = "这款酒的评分和酒花来源未提供，不能判断。";
  assert.equal(applyMenuEvidenceGuards(reply, memory), reply);
  assert.equal(applyMenuEvidenceGuards(reply, null), reply);
});
