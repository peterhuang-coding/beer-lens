import test from "node:test";
import assert from "node:assert/strict";
import { applyMenuEvidenceGuards } from "../lib/skills/beer-knowledge/evidence-guards.ts";

const memory = {
  lastMenu: {
    candidates: [
      { menuIndex: 1, displayName: "Your Young Lordship", price: 60, volumeMl: 425, currency: "CNY", brewery: "Stamm" },
      { menuIndex: 7, displayName: "Kölsch", price: 55, volumeMl: 425, currency: "CNY", brewery: "Gaffel" },
      { menuIndex: 2, displayName: "The Premium Malt's Black", price: 65, volumeMl: 300, currency: "CNY", brewery: "Suntory" },
    ],
  },
};

test("a contradicted lowest-price sentence is removed, not kept under a correction prefix", () => {
  const reply = "第一款在17款中是单价最低的（14.12元/100ml）。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.match(guarded, /【菜单算术核对】/);
  assert.match(guarded, /#7 Kölsch/);
  assert.match(guarded, /12\.94元\/100ml/);
  assert.doesNotMatch(guarded, /单价最低的（14\.12/);
  assert.doesNotMatch(guarded, /第一款在17款中是单价最低的/);
});

test("a correct cheapest sentence about the actual cheapest row is kept unchanged", () => {
  const reply = "单位价最低的是 #7 Kölsch（12.94元/100ml）。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.equal(guarded, reply);
});

test("unsourced brewery history is removed and caveated, not left verbatim", () => {
  const reply = "Gaffel 是德国百年老牌酒厂，生产正宗 Kölsch。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.match(guarded, /【来源核对】/);
  assert.doesNotMatch(guarded, /百年老牌/);
});

test("classic self-description cannot authorize flagship or bestseller for another row", () => {
  const cross = {
    lastMenu: {
      candidates: [
        {
          menuIndex: 1, displayName: "Other Beer", brewery: "Other Brewery",
          dossier: { brewery: { reputation: [{ value: { kind: "classic", text: "酒厂自述经典" } }] } },
        },
        { menuIndex: 7, displayName: "Target Beer", brewery: "Target Brewery" },
      ],
    },
  };
  const reply = "#7 Target Beer 是 Target Brewery 的旗舰和最畅销酒款。";
  const guarded = applyMenuEvidenceGuards(reply, cross);
  assert.match(guarded, /【来源核对】/);
  assert.doesNotMatch(guarded, /旗舰和最畅销/);
  assert.doesNotMatch(guarded, /Target Beer 是/);
});

test("a style-level historic phrase is not treated as a brewery claim", () => {
  const reply = "捷克皮尔森是历史悠久的经典风格，通常清爽平衡。";
  const guarded = applyMenuEvidenceGuards(reply, memory);
  assert.equal(guarded, reply);
});

test("an in-budget beer cannot remain described as over budget", () => {
  const budgetMemory = {
    currentConstraints: ["maxPrice:100"],
    lastMenu: { candidates: memCandidates() },
  };
  const reply = "#4 DDH Pseudo Sue 略超预算；#6 Cool Cool 略超预算；#8 Chubbles 超预算。";
  const guarded = applyMenuEvidenceGuards(reply, budgetMemory);
  assert.match(guarded, /【预算核对】/);
  assert.match(guarded, /#4 DDH Pseudo Sue（90元）/);
  assert.match(guarded, /#6 Cool Cool（90元）/);
  assert.doesNotMatch(guarded, /#4 DDH Pseudo Sue 略超预算/);
  assert.doesNotMatch(guarded, /#6 Cool Cool 略超预算/);
});

test("mixed currencies are never compared and USD is not rewritten as yuan", () => {
  const mixed = {
    lastMenu: {
      candidates: [
        { menuIndex: 1, displayName: "Yuan Beer", price: 20, volumeMl: 100, currency: "CNY" },
        { menuIndex: 2, displayName: "Dollar Beer", price: 10, volumeMl: 100, currency: "USD" },
      ],
    },
  };
  const reply = "第一款是单位价最低的。";
  const guarded = applyMenuEvidenceGuards(reply, mixed);
  assert.match(guarded, /【币种边界】/);
  assert.doesNotMatch(guarded, /10元\/100ml/);
  assert.doesNotMatch(guarded, /Dollar Beer（10元/);
  assert.doesNotMatch(guarded, /单位价最低的。/);
});

test("ordinary evidence-safe replies and missing memory are unchanged", () => {
  const reply = "这款酒的评分和酒花来源未提供，不能判断。";
  assert.equal(applyMenuEvidenceGuards(reply, memory), reply);
  assert.equal(applyMenuEvidenceGuards(reply, null), reply);
});

function memCandidates() {
  return [
    { menuIndex: 3, displayName: "Cyber Sue", price: 85, volumeMl: 425, currency: "CNY" },
    { menuIndex: 4, displayName: "DDH Pseudo Sue", price: 90, volumeMl: 425, currency: "CNY" },
    { menuIndex: 6, displayName: "Cool Cool", price: 90, volumeMl: 300, currency: "CNY" },
    { menuIndex: 8, displayName: "Chubbles", price: 130, volumeMl: 300, currency: "CNY" },
  ];
}
