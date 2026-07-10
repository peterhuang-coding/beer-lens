/**
 * Planner — decision engine and plan generation.
 *
 * Responsibilities:
 *   1. shouldUsePlanner() — decide whether a request needs multi-step planning
 *   2. generateRulePlan() — create a structured plan from rule templates
 *   3. validatePlan() — security/validity check before execution
 *
 * v1: Rule-based plan generation.
 * v2 (future): LLM-based plan generation via pipeline-config.json prompt.
 */

import type {
  IntentResult,
  IntentContext,
} from "@/lib/beer-agent/dialog-types";
import type {
  Plan,
  PlanStep,
  PlanToolId,
  PlannerDecision,
  PlannerContext,
} from "./types";
import type { ToolRegistry } from "./tools";

// ── Keywords that trigger planner (complex multi-step tasks) ──

const PLANNER_TRIGGER_KEYWORDS = [
  "帮我规划",
  "比较",
  "挑几款",
  "挑三款",
  "挑一款",
  "结合我偏好",
  "结合我的偏好",
  "最近喝过",
  "重新推荐",
  "分组",
  "这几款里",
  "按清爽",
  "按进阶",
  "按重口",
  "帮我挑",
  "帮我选",
  "对比",
  "帮我搭配",
  "排序",
  "排名",
  "从酒单",
  "结合口味",
  "综合推荐",
];

// ── Beer-domain keywords (used when intent confidence is low) ──

const BEER_DOMAIN_KEYWORDS = [
  "ipa", "IPA", "拉格", "lager", "Lager", "世涛", "stout", "Stout",
  "酸啤", "sour", "Sour", "小麦", "wheat", "Wheat", "皮尔森", "pilsner",
  "啤酒", "酒单", "酒款", "酒头", "tap", "酿造", "brew",
  "喝什么", "推荐", "清爽", "重口", "苦", "甜", "柑橘",
  "麦芽", "啤酒花", "hops", "malt", "abv", "ABV",
  "精酿", "craft", "瓶装", "瓶", "罐", "杯",
  "品饮", "品酒", "评分", "风格", "style",
  "浑浊", "帝国", "imperial", "session", "双倍", "double",
  "波特", "porter", "赛松", "saison", "大麦", "barleywine",
];

// ── Greeting patterns (always bypass planner) ──

const GREETING_PATTERNS = [
  /^(你好|您好|嗨|hi|hello|hey|早上好|晚上好|下午好)[!！。.]*$/i,
  /^(在吗|在不在|有人吗)[?？!！。.]*$/i,
  /^(谢谢|thanks|thank you|多谢|感谢|谢了)[!！。.]*$/i,
  /^(再见|拜拜|bye|goodbye|回头见|下次见)[!！。.]*$/i,
];

// ── Simple beer knowledge patterns (bypass planner) ──

const SIMPLE_KNOWLEDGE_PATTERNS = [
  /^什么是\s*(IPA|拉格|世涛|精酿|啤酒|ale|lager|stout|porter|pilsner|saison|wheat|sour|barleywine|bock)/i,
  /^(IPA|拉格|世涛|精酿|ale|lager|stout|porter)\s*(是什么|啥意思|什么意思)/i,
  /^(介绍|讲讲|说说).*(啤酒|风格|种类|类型)/i,
];

// ── Simple tasting feedback patterns (bypass planner) ──

const SIMPLE_FEEDBACK_PATTERNS = [
  /^[1-5]分/,
  /^[1-5]\/\d/,
  /^[1-5]\s*分/,
  /^(会|不会|可能|maybe)\s*(再|还)\s*(喝|点)/,
  /^\d+分.*(会|不会|可能)/,
];

// ═══════════════════════════════════════════════════════
// shouldUsePlanner
// ═══════════════════════════════════════════════════════

/**
 * Decide whether a request should go through the multi-step planner
 * instead of the simple intent → handler path.
 */
export function shouldUsePlanner(
  intentResult: IntentResult,
  context: IntentContext,
): PlannerDecision {
  const text = context.lastUserText.trim();
  const hasImage = context.hasImage;
  const isMultiIntent = intentResult.isMultiIntent;
  const confidence = intentResult.confidence;
  const intent = intentResult.intent;

  // ── Always bypass: simple greetings ──
  if (GREETING_PATTERNS.some((p) => p.test(text))) {
    return { usePlanner: false, reason: "greeting — bypass planner" };
  }

  // ── Always bypass: simple beer knowledge questions ──
  if (SIMPLE_KNOWLEDGE_PATTERNS.some((p) => p.test(text))) {
    return { usePlanner: false, reason: "simple beer knowledge — bypass planner" };
  }

  // ── Always bypass: simple tasting feedback ──
  if (SIMPLE_FEEDBACK_PATTERNS.some((p) => p.test(text))) {
    return { usePlanner: false, reason: "simple tasting feedback — bypass planner" };
  }

  // ── Explicit planner triggers ──
  // 1. Multi-intent detected — but bypass if primary intent has a working handler with image
  //    (label_check + image is handled correctly by the dispatcher; planner has no vision tool)
  if (isMultiIntent && intent === "label_check" && hasImage) {
    return {
      usePlanner: false,
      reason: `label_check + image — skip planner, use existing handler`,
    };
  }
  if (isMultiIntent) {
    return {
      usePlanner: true,
      reason: `multi-intent detected: ${intentResult.intents
        .map((i) => i.intent)
        .join(", ")}`,
    };
  }

  // 2. Has image AND memory correction
  if (hasImage && intent === "memory_correction") {
    return {
      usePlanner: true,
      reason: "image + memory_correction — complex correction flow",
    };
  }

  // 3. Planner trigger keywords in text
  const matchedKeywords = PLANNER_TRIGGER_KEYWORDS.filter((kw) =>
    text.includes(kw),
  );
  if (matchedKeywords.length > 0) {
    return {
      usePlanner: true,
      reason: `planner trigger keywords: ${matchedKeywords.join(", ")}`,
    };
  }

  // 4. Low confidence but beer-domain content
  if (confidence < 0.5) {
    const beerKeywordsFound = BEER_DOMAIN_KEYWORDS.filter((kw) =>
      text.includes(kw),
    );
    if (beerKeywordsFound.length >= 2) {
      return {
        usePlanner: true,
        reason: `low confidence (${(confidence * 100).toFixed(0)}%) + beer domain keywords: ${beerKeywordsFound.slice(0, 3).join(", ")}`,
      };
    }
  }

  // 5. Active menu + recommendation with constraints
  if (
    context.hasLastMenuCandidates &&
    intent === "menu_recommend" &&
    context.activeMenuCandidateCount > 2 &&
    context.profileSummary &&
    !context.profileSummary.includes("还没有正式记录")
  ) {
    return {
      usePlanner: true,
      reason: "active menu candidates + profile exists — complex recommendation",
    };
  }

  // 6. Memory correction + profile has evidence
  if (intent === "memory_correction" && context.profileSummary) {
    return {
      usePlanner: true,
      reason: "memory_correction with existing profile — correction → re-recommend flow",
    };
  }

  // ── Default: bypass planner, use existing handler ──
  return {
    usePlanner: false,
    reason: `simple request (intent=${intent}, confidence=${(confidence * 100).toFixed(0)}%) — use handler`,
  };
}

// ═══════════════════════════════════════════════════════
// generateRulePlan
// ═══════════════════════════════════════════════════════

/** Create a unique plan ID */
function createPlanId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a step with a unique ID */
function createStep(
  tool: PlanToolId,
  purpose: string,
  input: Record<string, unknown>,
): PlanStep {
  return {
    id: `step_${tool}_${Math.random().toString(36).slice(2, 6)}`,
    tool,
    purpose,
    input,
    status: "pending",
  };
}

/**
 * Generate a rule-based plan from known templates.
 *
 * Template selection is based on the trigger reason and context.
 * This is deterministic and traceable — no LLM involved in v1.
 */
export function generateRulePlan(
  triggerReason: string,
  context: PlannerContext,
  maxSteps: number = 4,
): Plan {
  const intentResult = context.intentResult;
  const intentContext = context.intentContext;
  const hasImage = intentContext.hasImage;
  const intent = intentResult.intent;
  const text = intentContext.lastUserText;
  const isMultiIntent = intentResult.isMultiIntent;

  const steps: PlanStep[] = [];

  // ── Step 1: Always classify intent (establishes baseline) ──
  steps.push(
    createStep("classify_intent", "Classify user intent to confirm routing", {
      text,
      hasImage,
    }),
  );

  // ── Determine plan template based on trigger ──

  // Template: "multi-intent + image + recommend" — full pipeline
  if (isMultiIntent && hasImage && intent === "menu_recommend") {
    steps.push(
      createStep("retrieve_memory", "Retrieve user taste profile and preferences", {
        userId: context.request.userId,
      }),
      createStep("search_beer_db", "Search beer database for candidates from OCR", {
        queries: extractBeerQueries(text),
      }),
      createStep(
        "score_recommendations",
        "Score candidates with worthScore + fitScore against user profile",
        {
          candidates: [],
          profile: null,
          constraints: extractConstraints(text),
        },
      ),
      createStep(
        "compose_answer",
        "Compose final recommendation reply with picks and reasoning",
        {
          toolOutputs: {}, // Will be populated by runner
          reason: triggerReason,
        },
      ),
    );
  }
  // Template: "correction + re-recommend"
  else if (
    intent === "memory_correction" &&
    intentContext.profileSummary &&
    !intentContext.profileSummary.includes("还没有正式记录")
  ) {
    steps.push(
      createStep("retrieve_memory", "Retrieve current user profile for correction context", {
        userId: context.request.userId,
      }),
      createStep(
        "update_profile_correction",
        "Parse and apply user correction to memory profile",
        { userId: context.request.userId, text },
      ),
      createStep(
        "score_recommendations",
        "Re-score recommendations with corrected profile",
        {
          candidates: [],
          profile: null,
          constraints: [],
        },
      ),
      createStep(
        "compose_answer",
        "Compose reply confirming correction and updated recommendations",
        { toolOutputs: {}, reason: triggerReason },
      ),
    );
  }
  // Template: "complex constraints / recommendation with profile"
  else if (
    intent === "menu_recommend" &&
    (text.includes("挑") || text.includes("选") || text.includes("分组") ||
     text.includes("规划") || text.includes("搭配") || text.includes("安排") || text.includes("设计"))
  ) {
    steps.push(
      createStep("retrieve_memory", "Retrieve user profile for personalized scoring", {
        userId: context.request.userId,
      }),
      createStep("search_beer_db", "Search beer database for relevant beers", {
        queries: extractBeerQueries(text),
      }),
      createStep(
        "score_recommendations",
        "Score with constraint-aware scoring",
        {
          candidates: [],
          profile: null,
          constraints: extractConstraints(text),
        },
      ),
      createStep(
        "compose_answer",
        "Compose constraint-aware recommendation reply",
        {
          toolOutputs: {},
          reason: triggerReason,
        },
      ),
    );
  }
  // Template: "low confidence beer complex" — clarify or minimal path
  else if (
    intentResult.confidence < 0.5 &&
    text.length > 0
  ) {
    // If there are specific missing pieces, ask clarifying
    if (intentResult.missingInfo && intentResult.missingInfo.length > 0) {
      steps.push(
        createStep("ask_clarifying_question", "Ask user for missing context", {
          missingContext: intentResult.missingInfo,
        }),
        createStep("compose_answer", "Return clarifying question to user", {
          toolOutputs: {},
          reason: triggerReason,
        }),
      );
    } else {
      // Minimal path: just try memory + compose
      steps.push(
        createStep("retrieve_memory", "Retrieve user profile for context", {
          userId: context.request.userId,
        }),
        createStep("compose_answer", "Compose contextual response", {
          toolOutputs: {},
          reason: triggerReason,
        }),
      );
    }
  }
  // Template: "default" — memory + compose
  else {
    steps.push(
      createStep("retrieve_memory", "Retrieve user profile and preferences", {
        userId: context.request.userId,
      }),
      createStep("compose_answer", "Compose final reply with available context", {
        toolOutputs: {},
        reason: triggerReason,
      }),
    );
  }

  // ── Trim to maxSteps ──
  const trimmedSteps = steps.slice(0, maxSteps);

  // ── Build diagnostics ──
  const selectedTools = [...new Set(trimmedSteps.map((s) => s.tool))];
  const missingContext: string[] = [];
  if (!intentContext.profileSummary || intentContext.profileSummary.includes("还没有正式记录")) {
    missingContext.push("limited_profile_data");
  }
  if (!intentContext.hasLastMenuCandidates) {
    missingContext.push("no_active_menu");
  }

  return {
    id: createPlanId(),
    reason: triggerReason,
    mode: "planner",
    maxSteps,
    steps: trimmedSteps,
    diagnostics: {
      triggerReason,
      selectedTools,
      missingContext,
      fallbackUsed: false,
    },
  };
}

// ═══════════════════════════════════════════════════════
// validatePlan
// ═══════════════════════════════════════════════════════

/** Dangerous key patterns that must not appear in tool input */
const DANGEROUS_KEY_PATTERNS = [
  /eval/i,
  /require/i,
  /import/i,
  /__proto__/,
  /constructor/,
  /prototype/,
  /exec\s*\(/,
  /Function\s*\(/,
];

/** Check if a key name looks dangerous */
function hasDangerousKeys(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  // Check top-level keys
  for (const key of keys) {
    if (DANGEROUS_KEY_PATTERNS.some((p) => p.test(key))) {
      return true;
    }
  }
  // Check string values (shallow)
  for (const value of Object.values(obj)) {
    if (typeof value === "string") {
      if (value.includes("eval(") || value.includes("require(") || value.includes("__proto__")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validate a plan before execution.
 *
 * Checks:
 *  - Step count <= maxSteps
 *  - All tools are in the registry whitelist
 *  - All tools are enabled
 *  - All step inputs are plain objects
 *  - No dangerous fields in inputs
 *  - No duplicate step IDs
 *  - All steps have a purpose string
 */
export function validatePlan(
  plan: Plan,
  toolRegistry: ToolRegistry,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // ── Step count ──
  if (plan.steps.length > plan.maxSteps) {
    errors.push(
      `Plan has ${plan.steps.length} steps but maxSteps is ${plan.maxSteps}`,
    );
  }
  if (plan.steps.length === 0) {
    errors.push("Plan has no steps");
  }

  // ── Tool whitelist ──
  const seenIds = new Set<string>();
  for (const step of plan.steps) {
    // Duplicate check
    if (seenIds.has(step.id)) {
      errors.push(`Duplicate step id: ${step.id}`);
    }
    seenIds.add(step.id);

    // Tool registered?
    if (!toolRegistry.isRegistered(step.tool)) {
      errors.push(`Unknown tool "${step.tool}" in step "${step.id}"`);
      continue;
    }

    // Tool enabled?
    if (!toolRegistry.isExecutable(step.tool)) {
      errors.push(`Tool "${step.tool}" is disabled in step "${step.id}"`);
    }

    // Input must be a plain object
    if (typeof step.input !== "object" || step.input === null || Array.isArray(step.input)) {
      errors.push(`Step "${step.id}" input must be a plain object, got ${typeof step.input}`);
      continue;
    }

    // No dangerous fields
    if (hasDangerousKeys(step.input)) {
      errors.push(`Step "${step.id}" input contains dangerous fields`);
    }

    // Must have a purpose
    if (!step.purpose || typeof step.purpose !== "string" || step.purpose.trim().length === 0) {
      errors.push(`Step "${step.id}" has no purpose`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

/** Extract potential beer name queries from user text */
function extractBeerQueries(text: string): string[] {
  const parts = text.split(/[\n\r,，、;；。\t]+/);
  return parts
    .map((p) => p.trim())
    .filter((p) => {
      if (!p || p.length < 2) return false;
      const stopWords = [
        "推荐", "帮我看", "看看", "帮我", "建议", "好喝", "什么",
        "怎么", "如何", "这个", "那个", "哪个",
        "第", "杯", "预算", "配餐", "清爽", "不苦",
        "帮我规划", "比较", "挑几款", "结合我偏好", "重新推荐",
      ];
      for (const sw of stopWords) {
        if (p.length <= 6 && p.includes(sw)) return false;
      }
      return true;
    })
    .slice(0, 10);
}

/** Extract constraint keywords from user text */
function extractConstraints(text: string): string[] {
  const constraints: string[] = [];
  const lower = text.toLowerCase();

  if (/清爽/.test(text)) constraints.push("清爽");
  if (/不苦/.test(text)) constraints.push("不苦");
  if (/重口/.test(text) || /浓郁/.test(text)) constraints.push("重口");
  if (/ipa/i.test(lower)) constraints.push("IPA");
  if (/拉格|lager/i.test(lower)) constraints.push("拉格");
  if (/世涛|stout/i.test(lower)) constraints.push("世涛");
  if (/酸/.test(text) && !text.includes("酸啤")) { /* skip standalone 酸 */ }
  if (/酸啤|sour/i.test(lower)) constraints.push("酸啤");
  if (/小麦|wheat/i.test(lower)) constraints.push("小麦");
  if (/低度数|低酒精|低ABV/.test(text)) constraints.push("低ABV");
  if (/高度数|烈性/.test(text)) constraints.push("高ABV");
  if (/国产/.test(text)) constraints.push("国产");
  if (/进口/.test(text)) constraints.push("进口");
  if (/性价比/.test(text)) constraints.push("性价比");

  return constraints;
}
