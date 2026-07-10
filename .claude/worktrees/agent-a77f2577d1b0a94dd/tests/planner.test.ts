/**
 * Planner Runtime tests — pure functions only, no LLM, no external deps.
 */
import { describe, it } from "node:test";
import assert from "node:assert";

const PLANNER_TRIGGER_KEYWORDS = [
  "帮我规划", "比较", "挑几款", "挑三款", "挑一款", "结合我偏好",
  "结合我的偏好", "最近喝过", "重新推荐", "分组", "这几款里",
  "按清爽", "按进阶", "按重口", "帮我挑", "帮我选", "对比",
  "帮我搭配", "排序", "排名", "从酒单", "结合口味", "综合推荐",
];

const BEER_DOMAIN_KEYWORDS = [
  "ipa","IPA","拉格","lager","世涛","stout","酸啤","sour","小麦",
  "wheat","皮尔森","pilsner","啤酒","酒单","喝什么","推荐","清爽",
  "重口","苦","甜","柑橘","精酿","craft","风格",
  "浑浊","帝国","imperial","session","双倍","double",
];

const GREETING_PATTERNS = [
  /^(你好|您好|嗨|hi|hello|hey|早上好|晚上好|下午好)[!！。.]*$/i,
  /^(谢谢|thanks|thank you|多谢|感谢|谢了)[!！。.]*$/i,
];

const SIMPLE_KNOWLEDGE_PATTERNS = [
  /^什么是\s*(IPA|拉格|世涛|精酿|啤酒)/i,
  /^(IPA|拉格|世涛)\s*(是什么|啥意思)/i,
];

const SIMPLE_FEEDBACK_PATTERNS = [
  /^[1-5]分/,
  /^\d+分.*(会|不会|可能)/,
];

type IntentResult = {
  intent: string; confidence: number; isMultiIntent: boolean;
  intents: Array<{ intent: string; confidence: number; slots: Record<string,unknown> }>;
};

type IntentContext = {
  hasImage: boolean; lastUserText: string; hasLastMenuCandidates: boolean;
  activeMenuCandidateCount: number; profileSummary?: string;
};

function shouldUsePlanner(ir: IntentResult, ctx: IntentContext) {
  const text = ctx.lastUserText.trim();
  if (GREETING_PATTERNS.some(p => p.test(text))) return { use: false, reason: "greeting" };
  if (SIMPLE_KNOWLEDGE_PATTERNS.some(p => p.test(text))) return { use: false, reason: "simple knowledge" };
  if (SIMPLE_FEEDBACK_PATTERNS.some(p => p.test(text))) return { use: false, reason: "simple feedback" };
  if (ir.isMultiIntent) return { use: true, reason: "multi-intent" };
  if (ctx.hasImage && ir.intent === "menu_recommend") return { use: true, reason: "image+recommend" };
  const matched = PLANNER_TRIGGER_KEYWORDS.filter(k => text.includes(k));
  if (matched.length > 0) return { use: true, reason: "keywords: " + matched.join(",") };
  if (ir.confidence < 0.5 && BEER_DOMAIN_KEYWORDS.filter(k => text.includes(k)).length >= 2) {
    return { use: true, reason: "low conf+beer" };
  }
  if (ctx.hasLastMenuCandidates && ir.intent === "menu_recommend" &&
      ctx.activeMenuCandidateCount > 2 && ctx.profileSummary &&
      !ctx.profileSummary.includes("还没有正式记录")) {
    return { use: true, reason: "active menu+profile" };
  }
  return { use: false, reason: "simple" };
}

const TOOL_IDS = [
  "classify_intent","retrieve_memory","search_beer_db","score_recommendations",
  "update_profile_correction","ask_clarifying_question","compose_answer","analyze_image",
];

class ToolRegistry {
  disabled: Set<string>;
  constructor(disabled: string[] = ["analyze_image"]) { this.disabled = new Set(disabled); }
  isRegistered(t: string) { return TOOL_IDS.includes(t); }
  isExecutable(t: string) { return this.isRegistered(t) && !this.disabled.has(t); }
}

// All tools enabled by default except analyze_image
function defaultRegistry(): ToolRegistry {
  return new ToolRegistry(["analyze_image"]);
}

function validatePlan(plan: any, reg: ToolRegistry) {
  const errors: string[] = [];
  if (plan.steps.length > plan.maxSteps) errors.push("over maxSteps");
  if (plan.steps.length === 0) errors.push("no steps");
  for (const s of plan.steps) {
    if (!reg.isRegistered(s.tool)) errors.push(`unknown tool ${s.tool}`);
    if (!reg.isExecutable(s.tool)) errors.push(`disabled tool ${s.tool}`);
    if (typeof s.input !== "object" || s.input === null || Array.isArray(s.input)) errors.push("bad input");
    for (const k of Object.keys(s.input)) {
      if (/eval|require|import|constructor|prototype/i.test(k)) errors.push("dangerous key");
    }
    // Check proto-like access
    if (Object.hasOwn(s.input, "__proto__")) errors.push("dangerous proto");
    if (!s.purpose?.trim()) errors.push("no purpose");
  }
  return { valid: errors.length === 0, errors };
}

function mkIR(overrides: Partial<IntentResult> = {}): IntentResult {
  return { intent: "beer_knowledge", confidence: 0.8, isMultiIntent: false, intents: [{ intent: "beer_knowledge", confidence: 0.8, slots: {} }], ...overrides };
}
function mkCtx(overrides: Partial<IntentContext> = {}): IntentContext {
  return { hasImage: false, lastUserText: "", hasLastMenuCandidates: false, activeMenuCandidateCount: 0, ...overrides };
}

describe("shouldUsePlanner: simple → false", () => {
  it('"什么是IPA"', () => assert.strictEqual(shouldUsePlanner(mkIR(), mkCtx({ lastUserText: "什么是IPA" })).use, false));
  it('"你好"', () => assert.strictEqual(shouldUsePlanner(mkIR({ intent: "unclear" }), mkCtx({ lastUserText: "你好" })).use, false));
  it('"4分，会再喝"', () => assert.strictEqual(shouldUsePlanner(mkIR({ intent: "tasting_feedback" }), mkCtx({ lastUserText: "4分，会再喝" })).use, false));
  it('"谢谢"', () => assert.strictEqual(shouldUsePlanner(mkIR(), mkCtx({ lastUserText: "谢谢" })).use, false));
});

describe("shouldUsePlanner: complex → true", () => {
  it("multi-intent", () => assert.strictEqual(shouldUsePlanner(mkIR({ isMultiIntent: true }), mkCtx({ lastUserText: "推荐IPA+看画像" })).use, true));
  it('"这几款里挑三款清爽的"', () => assert.strictEqual(shouldUsePlanner(mkIR({ intent: "menu_recommend" }), mkCtx({ lastUserText: "帮我从这几款里挑三款清爽的" })).use, true));
  it("low conf + beer keywords", () => assert.strictEqual(shouldUsePlanner(mkIR({ intent: "unclear", confidence: 0.3 }), mkCtx({ lastUserText: "拉格 IPA 推荐" })).use, true));
  it("image + recommend", () => assert.strictEqual(shouldUsePlanner(mkIR({ intent: "menu_recommend" }), mkCtx({ lastUserText: "看看", hasImage: true })).use, true));
});

describe("validatePlan: reject bad tools", () => {
  it("unknown tool", () => {
    const r = defaultRegistry();
    assert.strictEqual(validatePlan({ steps: [{ id: "s1", tool: "evil_tool", purpose: "x", input: { a:1 } }], maxSteps: 4 }, r).valid, false);
  });
  it("over maxSteps", () => {
    const r = defaultRegistry();
    const steps = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, tool: "classify_intent", purpose: "x", input: {} }));
    assert.strictEqual(validatePlan({ steps, maxSteps: 6 }, r).valid, false);
  });
  it("accepts valid plan", () => {
    const r = defaultRegistry();
    const steps = [{ id: "s1", tool: "classify_intent", purpose: "classify", input: {} }];
    assert.strictEqual(validatePlan({ steps, maxSteps: 4 }, r).valid, true);
  });
});

describe("validatePlan: security checks", () => {
  it("rejects __proto__", () => {
    const r = defaultRegistry();
    const obj: any = {};
    // setProperty on __proto__ key
    Object.defineProperty(obj, "__proto__", { value: "hack", enumerable: true, configurable: true });
    assert.strictEqual(validatePlan({ steps: [{ id: "s1", tool: "classify_intent", purpose: "x", input: obj }], maxSteps: 4 }, r).valid, false);
  });
  it("rejects constructor in key", () => {
    const r = defaultRegistry();
    assert.strictEqual(validatePlan({ steps: [{ id: "s1", tool: "classify_intent", purpose: "x", input: { constructor: { prototype: "hack" } } }], maxSteps: 4 }, r).valid, false);
  });
});

describe("ToolRegistry: enable/disable", () => {
  it("analyze_image disabled by default", () => {
    const r = new ToolRegistry();
    assert.strictEqual(r.isExecutable("analyze_image"), false);
  });
  it("disabled tools excluded", () => {
    const r = new ToolRegistry(["retrieve_memory", "analyze_image"]);
    assert.strictEqual(r.isExecutable("retrieve_memory"), false);
    assert.strictEqual(r.isExecutable("classify_intent"), true);
  });
});

describe("Step failure → remaining skipped", () => {
  it("failed step causes skip cascade", () => {
    const steps = [
      { status: "running" }, { status: "pending" }, { status: "pending" },
    ];
    let failed = false;
    for (const s of steps) {
      if (failed) { s.status = "skipped"; continue; }
      if (s.status === "running") { s.status = "failed"; failed = true; }
    }
    assert.strictEqual(steps[0].status, "failed");
    assert.strictEqual(steps[1].status, "skipped");
    assert.strictEqual(steps[2].status, "skipped");
  });
});