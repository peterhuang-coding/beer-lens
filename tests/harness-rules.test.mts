/**
 * Tests for the rule engine extensions:
 *   - transform_reply action (post-skill only)
 *   - retry_llm_with_hint action (pre-llm only)
 *   - rule short-circuit + priority ordering
 *   - rule:fire stage emitted with action_kind detail
 *
 * Run with:
 *   node --experimental-strip-types --test tests/harness-rules.test.mts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runRulesForStage } from "../lib/harness/rules-engine.ts";
import { _snapshotEnabled, _restoreEnabled, setRuleEnabled } from "../lib/harness/rules.ts";

test("post-skill transform_reply returns transformedReply and emits trace", () => {
  const snap = _snapshotEnabled();
  try {
    const out = runRulesForStage("post-skill", {
      message: "推荐 NEIPA",
      skill_id: "menu_recommend",
      reply: "NEIPA",
    }, { root_ts: 1, parent_ts: null });
    assert.equal(out.transformedReply, "NEIPA — 还想知道哪一款的细节?");
    assert.ok(out.firedRuleIds.includes("polish-short-reply"));
  } finally {
    _restoreEnabled(snap);
  }
});

test("post-skill transform_reply is no-op when reply is long", () => {
  const snap = _snapshotEnabled();
  try {
    const out = runRulesForStage("post-skill", {
      message: "推荐",
      skill_id: "menu_recommend",
      reply: "这是一段相当长的回复,有完整的中文标点和超过八个字符。",
    }, { root_ts: 1, parent_ts: null });
    assert.equal(out.transformedReply, null);
    assert.ok(!out.firedRuleIds.includes("polish-short-reply"));
  } finally {
    _restoreEnabled(snap);
  }
});

test("pre-llm retry_llm_with_hint fires when message contains menu words", () => {
  const snap = _snapshotEnabled();
  try {
    const out = runRulesForStage("pre-llm", {
      message: "这酒单帮我挑一杯 IPA",
    }, { root_ts: 1, parent_ts: null });
    assert.ok(out.retryHint);
    assert.match(out.retryHint!.hint, /menu_recommend/);
    assert.ok(out.firedRuleIds.includes("retry-llm-unclear-lean-menu"));
  } finally {
    _restoreEnabled(snap);
  }
});

test("pre-llm retry_llm_with_hint does NOT fire for non-menu messages", () => {
  const snap = _snapshotEnabled();
  try {
    const out = runRulesForStage("pre-llm", {
      message: "什么是 NEIPA?",
    }, { root_ts: 1, parent_ts: null });
    assert.equal(out.retryHint, null);
    assert.ok(!out.firedRuleIds.includes("retry-llm-unclear-lean-menu"));
  } finally {
    _restoreEnabled(snap);
  }
});

test("block short-circuits and skips lower-priority rules", () => {
  const snap = _snapshotEnabled();
  try {
    // cross-skill-freshness-block has priority 90 and blocks if
    // label_check.freshness === stale and skill_id === menu_recommend.
    const out = runRulesForStage("pre-skill", {
      skill_id: "menu_recommend",
      annotations: { "label_check.freshness": "stale" },
    }, { root_ts: 1, parent_ts: null });
    assert.ok(out.action);
    assert.equal(out.action.kind, "block");
    assert.ok(out.firedRuleIds.includes("cross-skill-freshness-block"));
  } finally {
    _restoreEnabled(snap);
  }
});

test("annotations accumulate across rules", () => {
  const snap = _snapshotEnabled();
  try {
    // post-llm image-ocr-freshness fires when llm_response has stale flag.
    const out = runRulesForStage("post-llm", {
      llm_response: { freshnessAssessment: "stale" },
    }, { root_ts: 1, parent_ts: null });
    assert.equal(out.annotations["label_check.freshness"], "stale");
  } finally {
    _restoreEnabled(snap);
  }
});

test("toggling rule off removes its fire", () => {
  const snap = _snapshotEnabled();
  try {
    // Disable polish-short-reply.
    setRuleEnabled("polish-short-reply", false);
    const out = runRulesForStage("post-skill", {
      skill_id: "menu_recommend",
      reply: "NEIPA",
    }, { root_ts: 1, parent_ts: null });
    assert.equal(out.transformedReply, null);
    assert.ok(!out.firedRuleIds.includes("polish-short-reply"));
  } finally {
    _restoreEnabled(snap);
  }
});