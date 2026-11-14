import test from "node:test";
import assert from "node:assert/strict";
import { parseMenuInput } from "../lib/beer-agent/recommendation/menu-input.ts";
import { knowledgeFollowUpIntent } from "../lib/agent/skill-routing.ts";
import { formatImageCoverageNote } from "../lib/beer-agent/menu-coverage.ts";

test("budget constraint prose is a follow-up request, not a one-row menu", () => {
  const parsed = parseMenuInput("我预算100元以内，想要清爽不苦，选哪款？");
  assert.equal(parsed.isMenu, false);
  assert.equal(parsed.items.length, 0);
  assert.match(parsed.requestText, /预算100元以内/);
});

test("plain budget / ordinal / knowledge follow-ups do not become menus", () => {
  for (const text of ["预算改成60元", "第7款多少钱？", "哪款酒花最香？", "哪款是经典款？"]) {
    const parsed = parseMenuInput(text);
    assert.equal(parsed.isMenu, false, text);
    assert.equal(parsed.items.length, 0, text);
  }
});

test("real pasted menu rows are still extracted with row evidence", () => {
  const rows = parseMenuInput("1. Gaffel Kölsch 55元 425ml\n#7 嘉馥 科隆 4.8% 425ml ¥55");
  assert.equal(rows.isMenu, true);
  assert.equal(rows.items.length, 2);
  assert.equal(rows.items[0].beerName, "Gaffel Kölsch");
  assert.equal(rows.items[0].price, 55);
  assert.equal(rows.items[0].volumeMl, 425);
});

test("knowledge words route to sourced knowledge only on an active menu", () => {
  assert.equal(knowledgeFollowUpIntent("哪款酒花最香？", true), true);
  assert.equal(knowledgeFollowUpIntent("哪款是经典款？", true), true);
  assert.equal(knowledgeFollowUpIntent("第7款评分多少？", true), true);
  assert.equal(knowledgeFollowUpIntent("这单的酒产地在哪里？", true), true);
  assert.equal(knowledgeFollowUpIntent("哪款酒花最香？", false), false);
});

test("image coverage note surfaces reflective/cropped rows instead of claiming completeness", () => {
  const note = formatImageCoverageNote({
    uncertainties: [
      "5号位卡片反光/空白，编号中缺5，内容不可读",
      "右侧边缘 19、20 号酒款被画面裁切，未纳入",
    ],
  }, 17);
  assert.match(note, /识别到 17 款/);
  assert.match(note, /反光\/空白/);
  assert.match(note, /裁切/);
  assert.doesNotMatch(note, /币种/);
  assert.equal(formatImageCoverageNote({ uncertainties: ["币种按 ¥ 推定"] }, 17), "");
  assert.equal(formatImageCoverageNote({ uncertainties: [] }, 0), "");
});

test("budget, price, selection and swap requests stay deterministic", () => {
  for (const text of [
    "我预算100元以内，想要清爽不苦，选哪款？",
    "第7款多少钱？",
    "这单里哪款最便宜？",
    "推荐一款经典IPA",
    "换一款酒花轻一点的",
  ]) {
    assert.equal(knowledgeFollowUpIntent(text, true), false, text);
  }
});
