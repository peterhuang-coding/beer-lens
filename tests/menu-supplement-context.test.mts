// Regression tests for public social_web menu supplements in follow-up
// knowledge context. Synthetic fixtures only — no real OCR/model output,
// no network/DB. Run together with the existing context suite:
// node --experimental-strip-types --test \
//   tests/menu-knowledge-context.test.mts tests/menu-supplement-context.test.mts

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMenuContext,
  renderMenuContext,
} from "../lib/skills/beer-knowledge/menu-context.ts";

function beer(over = {}) {
  return {
    candidateId: `cand-${over.menuIndex ?? 1}`,
    menuIndex: 1,
    displayName: "Beer",
    brewery: "Brewery",
    style: null,
    abv: null,
    untappdScore: null,
    untappdRatingCount: null,
    price: null,
    volumeMl: null,
    currency: null,
    evidence: [],
    ...over,
  };
}

function memory(candidates, activeBeer = null, source = "ocr", createdAt = "2026-10-21T09:00:00Z") {
  return {
    lastMenu: { traceId: "trace-supplement", source, createdAt, candidates },
    activeBeer,
  };
}

// A >220-char public social_web supplement: description first, URL and the
// ABV conflict both sit past char 220, so the old 220-char cap loses them
// even when the entry survives the first-3 scan.
function socialNote() {
  const head =
    "公开社交贴文补充酒单信息：这是一款当日酒头的帝国世涛，据酒厂社交账号公开配图，";
  const pad = "带有黑巧克力、浓缩咖啡与烤橡木气息，";
  const description = head + pad.repeat(11);
  const url = "https://social.example.com/brewery/2026-09/menu-note?ref=menu";
  const conflict =
    " 另注：现场印刷菜单标注 6.8% ABV，酒厂公开贴文更正批次为 7.2% ABV，以贴文附图酒标为准。";
  return `${description}原文链接 ${url}。${conflict}`;
}

const note = socialNote();
const socialUrl = "https://social.example.com/brewery/2026-09/menu-note?ref=menu";
const conflictPhrase = "更正批次为 7.2% ABV";

// Synthetic 17-beer menu; the supplemented beer is the explicit LAST row,
// outside the default first-8 window.
function menu17() {
  const rows = Array.from({ length: 16 }, (_, i) =>
    beer({
      candidateId: `cand-${i + 1}`,
      menuIndex: i + 1,
      displayName: `Catalog Beer ${i + 1}`,
      brewery: `Brewery ${i + 1}`,
      evidence: [{ source: "ocr", summary: `菜单 #${i + 1} 基础 OCR 摘要`, confidence: 0.9 }],
    }),
  );
  rows.push(
    beer({
      candidateId: "cand-17",
      menuIndex: 17,
      displayName: "Midnight Stout",
      brewery: "Riverside Craft",
      style: "Imperial Stout",
      abv: 6.8,
      evidence: [
        { source: "ocr", summary: "菜单 #17：Midnight Stout / Riverside Craft，6.8% ABV", confidence: 0.95 },
        { source: "untappd", summary: "Dark and roasty, thick body", confidence: 0.8 },
        { source: "agent_inference", summary: "可能偏烘焙、偏厚重", confidence: 0.4 },
        // Public supplement appended AFTER the three older evidence entries.
        { source: "social_web", summary: note, confidence: 0.6 },
      ],
    }),
  );
  return rows;
}

describe("social_web supplement in follow-up context", () => {
  it("keeps the >220-char social_web note (description, URL, ABV conflict) for an explicit last-row beer under strict caps", () => {
    // Fixture self-check: conflict/URL must live past the old 220 cap.
    assert.ok(note.length > 220, `note should exceed 220 chars, got ${note.length}`);
    assert.ok(note.indexOf(socialUrl) > 220);
    assert.ok(note.indexOf(conflictPhrase) > 220);

    const mem = memory(menu17());
    const ctx = buildMenuContext(mem, "#17 这款社交贴文怎么说？");

    // Explicit beer beyond first 8 is swapped in; candidate cap stays 8.
    assert.equal(ctx.totalCandidates, 17);
    assert.equal(ctx.shownCandidates.length, 8);
    assert.equal(ctx.truncatedCount, 9);
    assert.equal(ctx.reference.kind, "menu");
    if (ctx.reference.kind === "menu") {
      assert.deepEqual(ctx.reference.beers.map((b) => b.menuIndex), [17]);
    }
    const target = ctx.shownCandidates.find((b) => b.candidateId === "cand-17");
    assert.ok(target, "explicit #17 must be among shown candidates");
    if (!target) throw new Error("unreachable");

    // Evidence cap stays 3: oldest two legacy snippets + the fresh supplement;
    // one older snippet is dropped so social_web survives.
    assert.equal(target.evidence.length, 3);
    assert.deepEqual(
      target.evidence.map((e) => e.source),
      ["ocr", "untappd", "social_web"],
    );

    const social = target.evidence.find((e) => e.source === "social_web");
    assert.ok(social);
    if (!social) throw new Error("unreachable");
    // Full supplement retained under the shared 1200 sourced-evidence budget.
    assert.equal(social.summary.length, note.length);
    assert.ok(social.summary.includes(socialUrl));
    assert.ok(social.summary.includes(conflictPhrase));
    assert.ok(social.summary.includes("6.8% ABV"));

    const section = renderMenuContext(ctx);
    assert.match(section, /\[来源:social_web\]/);
    assert.ok(section.includes(socialUrl), "URL must render verbatim");
    assert.match(section, /更正批次为 7\.2% ABV/);
    assert.match(section, /现场印刷菜单标注 6\.8% ABV/);

    // No relabeling: the conflict line is attributed to social_web only,
    // never upgraded into venue_site / untappd evidence.
    const conflictLine = section
      .split("\n")
      .find((l) => l.includes("7.2% ABV"));
    assert.ok(conflictLine);
    if (conflictLine) {
      assert.match(conflictLine, /\[来源:social_web\]/);
      assert.doesNotMatch(conflictLine, /venue_site|untappd/);
    }

    // Strict global caps on the rendered context.
    for (const b of ctx.shownCandidates) {
      assert.ok(b.evidence.length <= 3);
      for (const e of b.evidence) assert.ok(e.summary.length <= 1200);
    }
  });

  it("keeps mixed venue_site and social_web sourced evidence together, both past 220 chars", () => {
    const venueChunk =
      "brewer-published tasting notes with glass photo and serving size; ";
    const venueNote =
      "Official venue catalog: " +
      venueChunk.repeat(3) +
      "brewer-published tasting notes with glass photo and serving size.";
    const mixed = beer({
      candidateId: "cand-m5",
      menuIndex: 5,
      displayName: "Mixed Source Beer",
      brewery: "Mixed Brewery",
      evidence: [
        { source: "ocr", summary: "菜单 #5 Mixed Source Beer", confidence: 0.9 },
        { source: "venue_site", summary: venueNote, confidence: 0.9 },
        { source: "social_web", summary: note, confidence: 0.6 },
      ],
    });
    assert.ok(venueNote.length > 220 && venueNote.length <= 1200);

    const ctx = buildMenuContext(memory([mixed]), "#5 有哪些来源？");
    const row = ctx.shownCandidates[0];
    assert.equal(row.evidence.length, 3);
    assert.deepEqual(
      row.evidence.map((e) => e.source),
      ["ocr", "venue_site", "social_web"],
    );
    assert.equal(row.evidence[1].summary.length, venueNote.length);
    assert.equal(row.evidence[2].summary.length, note.length);

    const section = renderMenuContext(ctx);
    assert.match(section, /\[来源:venue_site\]/);
    assert.match(section, /\[来源:social_web\]/);
    assert.ok(section.includes(socialUrl));
    assert.match(section, /Official venue catalog/);
  });

  it("keeps all three when evidence is 2 venue_site + 1 social_web", () => {
    const mixed = beer({
      candidateId: "cand-m9",
      menuIndex: 9,
      displayName: "Two Venue Social",
      brewery: "Triple Source",
      evidence: [
        { source: "ocr", summary: "legacy ocr snippet that must be dropped", confidence: 0.9 },
        { source: "agent_inference", summary: "legacy inference that must be dropped", confidence: 0.3 },
        { source: "venue_site", summary: "venue catalog note one", confidence: 0.9 },
        { source: "venue_site", summary: "venue catalog note two", confidence: 0.9 },
        { source: "social_web", summary: note, confidence: 0.6 },
      ],
    });
    const ctx = buildMenuContext(memory([mixed]), "#9 来源呢");
    const row = ctx.shownCandidates[0];
    assert.equal(row.evidence.length, 3);
    assert.deepEqual(
      row.evidence.map((e) => e.source),
      ["venue_site", "venue_site", "social_web"],
    );
    assert.equal(row.evidence[2].summary.length, note.length);
    assert.ok(row.evidence[2].summary.includes(conflictPhrase));
  });

  it("bounds an oversized social_web supplement at the strict 1200-char budget", () => {
    const huge =
      "公开社交贴文补充：" +
      "酒单证据超长时必须按严格字符预算截断，不能挤爆上下文窗口，".repeat(45);
    assert.ok(huge.length > 1200, `fixture should exceed 1200, got ${huge.length}`);
    const over = beer({
      candidateId: "cand-huge",
      menuIndex: 2,
      displayName: "Huge Note Beer",
      brewery: "Huge Brewery",
      evidence: [
        { source: "ocr", summary: "菜单 #2 Huge Note Beer", confidence: 0.9 },
        { source: "untappd", summary: "checkin blurb", confidence: 0.8 },
        { source: "agent_inference", summary: "旧推断", confidence: 0.4 },
        { source: "social_web", summary: huge, confidence: 0.6 },
      ],
    });
    const ctx = buildMenuContext(memory([over]), "#2 详细说说");
    const row = ctx.shownCandidates[0];
    assert.equal(row.evidence.length, 3);
    const social = row.evidence.find((e) => e.source === "social_web");
    assert.ok(social);
    if (!social) throw new Error("unreachable");
    assert.equal(social.summary.length, 1200);
    assert.ok(social.summary.endsWith("…"));
    const section = renderMenuContext(ctx);
    assert.ok(section.length < huge.length * 2);
  });

  it("keeps legacy first-3 / 220-char behavior when no venue_site or social_web exists", () => {
    const longLegacy = "旧库记录 " + "x".repeat(260);
    const legacy = beer({
      candidateId: "cand-old",
      menuIndex: 6,
      displayName: "Legacy Only Beer",
      brewery: "Old Brewery",
      evidence: [
        { source: "ocr", summary: "one" },
        { source: "untappd", summary: longLegacy },
        { source: "agent_inference", summary: "three" },
        { source: "legacy_db", summary: "four must be dropped" },
      ],
    });
    const ctx = buildMenuContext(memory([legacy]), "#6 呢");
    const row = ctx.shownCandidates[0];
    assert.equal(row.evidence.length, 3);
    assert.deepEqual(
      row.evidence.map((e) => e.source),
      ["ocr", "untappd", "agent_inference"],
    );
    assert.equal(row.evidence[1].summary.length, 220);
    assert.ok(!row.evidence.some((e) => e.source === "legacy_db"));
  });
});
