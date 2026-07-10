/**
 * Intent Registry — full-featured intent recognition engine.
 *
 * Supports:
 *   - Positive rules (regex hit → match)
 *   - Negative rules (regex hit → exclude this intent)
 *   - Explicit priority ordering
 *   - Rich context conditions (active menu, turn distance, profile state)
 *   - Per-intent slot definitions
 *   - Sample matching (few-shot keyword scoring)
 *   - Query rewriting (multi-turn context completion placeholder)
 *   - Dry-run testing with detailed diagnostics
 *
 * Architecture:
 *   classify(text, ctx) → Priority 0: overrides → Priority 1: rules → Priority 2: samples → Priority 3: LLM
 */

import type { BeerIntent, KNOWN_INTENTS } from "./dialog-types";
import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** A single rule — positive or negative */
export type IntentRule = {
  /** Unique id for this rule (for debugging) */
  id: string;
  /** Regex pattern as string (JSON-serializable) */
  pattern: string;
  /** positive = regex hit means match; negative = regex hit means exclude */
  type: "positive" | "negative";
  /** Confidence when this rule matches (only for positive rules) */
  confidence: number;
  /** Whether this rule requires an image */
  requiresImage: boolean;
  /** Optional: require specific context conditions */
  conditions?: RuleCondition[];
};

/** Conditions that must ALL be met for a rule to fire */
export type RuleCondition = {
  field: "hasActiveMenu" | "turnsSinceMenu" | "activeMenuCandidateCount" | "hasTastingHistory" | "episodeCount";
  op: "eq" | "gt" | "gte" | "lt" | "lte";
  value: number | boolean;
};

/** A slot (entity) that should be extracted from user text */
export type SlotDefinition = {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  /** Regex to extract (first capture group) */
  pattern?: string;
  /** Allowed values for enum type */
  enumValues?: string[];
  /** Description for LLM context */
  description?: string;
  /** Whether this slot is required */
  required?: boolean;
  /** Default value if not extracted */
  defaultValue?: unknown;
};

/** A few-shot sample for keyword/semantic matching */
export type IntentSample = {
  /** User query text */
  text: string;
  /** Match weight (0-1) */
  weight: number;
  /** Expected intent output */
  expectedIntent?: BeerIntent;
  /** Expected slots (for verification) */
  expectedSlots?: Record<string, string>;
  /** Notes about this sample */
  note?: string;
};

/** Prompt template for LLM intent classification (the "boundary prompt") */
export type IntentPrompt = {
  /** System prompt that defines this intent's scope and boundaries */
  systemPrompt: string;
  /** Few-shot examples to include in the prompt */
  examples: string[];
  /** Negative examples (what this intent is NOT) */
  negativeExamples: string[];
  /** When to use this intent vs others (disambiguation guide) */
  disambiguation: string;
};

/** Full intent definition */
export type IntentDefinition = {
  id: BeerIntent;
  /** Human-readable label (Chinese) */
  label: string;
  /** Detailed description of what this intent handles */
  description: string;
  /** Explicit priority (lower = higher priority). Default 50. */
  priority: number;
  /** Rules — positive and negative regex patterns */
  rules: IntentRule[];
  /** LLM boundary prompt — defines intent scope and disambiguation */
  prompt?: IntentPrompt;
  /** Samples for few-shot matching */
  samples?: IntentSample[];
  /** Slots to extract when this intent matches */
  slots?: SlotDefinition[];
  /** Handler function name */
  handler: string;
  /** Whether this intent can be triggered by image input */
  supportsImage: boolean;
  /** Tags for categorization / filtering in UI */
  tags?: string[];
  /** Whether this intent is enabled (can be toggled) */
  enabled?: boolean;
  /** Version of this intent definition */
  version?: number;
  /** When this intent was last modified */
  updatedAt?: string;
};

/** Result of a single intent test */
export type IntentTestResult = {
  input: { text: string; hasImage: boolean };
  /** All matched intents with diagnostics */
  matched: IntentMatchDetail[];
  primary: BeerIntent;
  isMultiIntent: boolean;
  source: "override" | "rule" | "sample" | "llm" | "no_match";
  /** Detailed trace of every rule evaluation */
  trace: RuleTrace[];
};

export type IntentMatchDetail = {
  intent: BeerIntent;
  label: string;
  confidence: number;
  /** Which rule matched (rule id) */
  ruleId?: string;
  /** Source of the match */
  source: "override" | "positive_rule" | "sample_match" | "llm";
};

export type RuleTrace = {
  intentId: BeerIntent;
  ruleId: string;
  type: "positive" | "negative";
  matched: boolean;
  confidence?: number;
  reason: string;
};

// ═══════════════════════════════════════════════════════════════
// Intent Registry
// ═══════════════════════════════════════════════════════════════

export const INTENT_REGISTRY: IntentDefinition[] = [
  {
    id: "menu_recommend",
    label: "酒单推荐",
    description: "拍照酒单 → OCR 识别 → Beer DB 查评分 → 推荐引擎打分 → top/safe/explore/avoid",
    priority: 10,
    rules: [
      {
        id: "menu_img_keywords",
        pattern: "酒单|推荐|喝什么|帮我看酒单",
        type: "positive",
        confidence: 0.95,
        requiresImage: true,
      },
      {
        id: "menu_img_any",
        pattern: ".*",
        type: "positive",
        confidence: 0.85,
        requiresImage: true,
      },
      {
        id: "menu_text_recommend",
        pattern: "推荐.*啤酒|推荐.*IPA|推荐.*拉格|帮我.*选|帮我.*挑|帮我推荐|有什么.*推荐|推荐一款|喝什么.*好|今天.*喝.*什么|帮我.*推荐|推荐一下|推荐.*给我|推荐.*下|下一杯|下一款|再来.*杯|再来.*款",
        type: "positive",
        confidence: 0.90,
        requiresImage: false,
      },
      // ── 意向性表达（模糊 → 推断为推荐意图）──
      {
        id: "menu_implicit_want",
        pattern: "想喝|好想喝|想试试|想尝|想试|馋了|想喝点|想.*一杯|想.*来.*杯|好渴|热.*喝|天.*热.*喝|口渴|想.*啤",
        type: "positive",
        confidence: 0.75,
        requiresImage: false,
      },
      {
        id: "menu_implicit_explore",
        pattern: "有什么.*新|最近.*流行|新出.*什么|有什么.*特别|有什么.*好|没喝过.*推荐|换.*口味|试.*新的|尝.*新的",
        type: "positive",
        confidence: 0.72,
        requiresImage: false,
      },
      // ── 追问/筛选关键词（有活跃菜单时触发推荐路径的 follow-up 模式）──
      {
        id: "menu_followup_keywords",
        pattern: "有.*吗|有没有|不苦|不要太苦|太苦|清爽|第.*个|第.*款|第.*杯|哪个|多少钱|介绍一下|说说|尝新|便宜的|贵的|推荐.*第",
        type: "positive",
        confidence: 0.78,
        requiresImage: false,
        conditions: [
          { field: "hasActiveMenu", op: "eq", value: true },
          { field: "turnsSinceMenu", op: "lt", value: 30 },
        ],
      },
      // Negative: only exclude if the text is PURELY about label/date (not mixed with recommendation keywords)
      {
        id: "menu_not_pure_label",
        pattern: "^(酒标|生产日期|过期|这瓶|这罐|日期).{0,10}$",
        type: "negative",
        confidence: 0,
        requiresImage: false,
      },
      {
        id: "menu_not_pure_feedback",
        pattern: "^\\d+(\\.\\d+)?\\s*分\\s*(会再喝|不会再喝|看情况|柑橘|热带水果|清爽|顺滑|苦|甜|酸|咖啡|焦糖|花香)",
        type: "negative",
        confidence: 0,
        requiresImage: false,
      },
    ],
    samples: [
      { text: "推荐一款IPA", weight: 0.85, expectedIntent: "menu_recommend", note: "纯文字推荐" },
      { text: "帮我推荐一下", weight: 0.82, expectedIntent: "menu_recommend", note: "请求推荐" },
      { text: "今天喝什么好", weight: 0.78, expectedIntent: "menu_recommend", note: "日常推荐" },
      { text: "有什么好喝的啤酒", weight: 0.80, expectedIntent: "menu_recommend", note: "询问推荐" },
      { text: "帮我选一款", weight: 0.80, expectedIntent: "menu_recommend", note: "选酒请求" },
      { text: "给我推荐个清爽的", weight: 0.82, expectedIntent: "menu_recommend", note: "风格偏好推荐" },
    ],
    prompt: {
      systemPrompt: "你是 Beer Lens 的酒单推荐意图识别器。当用户表达了推荐啤酒、选酒、帮看酒单的需求时匹配此意图。这包括：拍照上传酒单、文字描述想喝什么风格、请求推荐具体的啤酒。边界：纯粹的知识问答（\"什么是IPA\"）不是推荐，评分反馈（\"4分\"）不是推荐。",
      examples: ["推荐一款IPA", "帮我看看这张酒单", "今天喝什么好", "有什么推荐的"],
      negativeExamples: ["什么是IPA", "4分，会再喝", "我的口味是什么"],
      disambiguation: "当用户同时表达了推荐和另一个意图时，如果推荐是主要需求则匹配此意图。如果推荐只是附带（如\"推荐一款IPA，顺便看看我口味\"），则根据主次判断。",
    },
    slots: [
      { name: "style", label: "风格偏好", type: "string", pattern: "IPA|拉格|lager|世涛|stout|皮尔森|pilsner|酸|sour|小麦|wheat|清爽|烈|淡" },
      { name: "beerName", label: "酒名", type: "string", pattern: "[A-Za-z一-鿿·\\- ]{2,30}" },
      { name: "menuIndex", label: "序号", type: "number", pattern: "(\\d+)\\s*[号#]" },
    ],
    handler: "handleMenuRecommend",
    supportsImage: true,
  },

  {
    id: "label_check",
    label: "酒标检查",
    description: "拍照单瓶/单罐 → 识别酒名、日期、新鲜度风险",
    priority: 15,
    rules: [
      {
        id: "label_keywords",
        pattern: "酒标|生产日期|过期|这瓶|这罐|这是啥酒|这是.*酒|什么酒|啥酒|哪款酒|这是什么|这是啥|这是.*啤酒|看看酒标|看看.*酒标|帮我.*酒标",
        type: "positive",
        confidence: 0.95,
        requiresImage: true,
      },
      // Negative: if user is clearly asking for menu recommendation WITH an image
      {
        id: "label_not_pure_menu",
        pattern: "^(酒单|推荐|帮我.*选|帮我.*挑|喝什么).{0,15}$",
        type: "negative",
        confidence: 0,
        requiresImage: false,
      },
    ],
    samples: [
      { text: "帮我看看这瓶酒的生产日期", weight: 0.90, expectedIntent: "label_check", note: "检查日期" },
      { text: "这个酒标是什么", weight: 0.85, expectedIntent: "label_check", note: "酒标识别" },
      { text: "看看过期没", weight: 0.82, expectedIntent: "label_check", note: "新鲜度检查" },
    ],
    prompt: {
      systemPrompt: "你是 Beer Lens 的酒标检查意图识别器。当用户拍下单个酒瓶/酒罐的照片并询问酒的信息时匹配此意图。典型场景：检查生产日期、识别酒标上的文字、判断新鲜度、确认酒名和酒厂。边界：拍酒单（多款酒的列表）不是酒标检查，那是 menu_recommend。纯文字聊天询问啤酒知识也不是。",
      examples: ["帮我看看这瓶酒的生产日期", "这罐酒标是什么", "看看过期没"],
      negativeExamples: ["帮我看看这张酒单", "这瓶酒好喝吗", "推荐一款IPA"],
      disambiguation: "当用户上传了图片且文本明确提到酒标/日期/这瓶/这罐时匹配此意图。如果用户上传的是酒单（多款酒列表），则应该是 menu_recommend。",
    },
    slots: [
      { name: "beerName", label: "酒名", type: "string" },
      { name: "packagingDate", label: "包装日期", type: "string", pattern: "\\d{4}[-./]\\d{1,2}[-./]\\d{1,2}" },
    ],
    handler: "handleLabelCheck",
    supportsImage: true,
  },

  {
    id: "tasting_feedback",
    label: "品饮反馈",
    description: "解析评分(1-5分)、是否再喝、风味标签 → 写入 episodic memory → 重建口味画像",
    priority: 20,
    rules: [
      {
        id: "feedback_score",
        pattern: "[1-5](\\.\\d+)?\\s*分",
        type: "positive",
        confidence: 0.92,
        requiresImage: false,
      },
      {
        id: "feedback_would_again",
        pattern: "会再喝|不会再喝|看情况",
        type: "positive",
        confidence: 0.90,
        requiresImage: false,
      },
    ],
    samples: [
      { text: "4分，会再喝，柑橘味很重", weight: 0.95, expectedIntent: "tasting_feedback", note: "标准反馈" },
      { text: "3.5分，不会再喝", weight: 0.92, expectedIntent: "tasting_feedback", note: "低分反馈" },
      { text: "这杯不错，给4.5分", weight: 0.90, expectedIntent: "tasting_feedback", note: "高分好评" },
      { text: "喝了感觉一般，2分", weight: 0.88, expectedIntent: "tasting_feedback", note: "一般评价" },
    ],
    prompt: {
      systemPrompt: "你是 Beer Lens 的品饮反馈意图识别器。当用户对已经喝过的啤酒给出评价时匹配此意图。关键信号：数字评分（1-5分）、是否再喝的意愿（会再喝/不会再喝/看情况）、风味描述（柑橘、热带水果、苦、甜等）。边界：询问评分标准不是反馈，推荐酒款不是反馈，询问某款酒的评分不是反馈。",
      examples: ["4分，会再喝，柑橘味很重", "3.5分，不会再喝，太苦了", "这杯不错给4.5分"],
      negativeExamples: ["评分标准是什么", "这款酒多少分", "推荐一款IPA"],
      disambiguation: "当用户同时包含评分和推荐意图时（如\"4分，再推荐一款IPA\"），如果评分描述是主体则匹配此意图作为主意图。",
    },
    slots: [
      { name: "score", label: "评分", type: "number", pattern: "([1-5](?:\\.\\d+)?)\\s*分" },
      { name: "wouldDrinkAgain", label: "是否再喝", type: "enum", enumValues: ["yes", "maybe", "no"] },
      { name: "flavorTags", label: "风味标签", type: "string", pattern: "柑橘|热带水果|清爽|顺滑|苦|甜|酸|咖啡|焦糖|花香" },
    ],
    handler: "handleTastingFeedback",
    supportsImage: false,
  },

  {
    id: "profile_query",
    label: "画像查询",
    description: "查询用户口味画像：偏好风格、风味标签、ABV 舒适区间",
    priority: 25,
    rules: [
      {
        id: "profile_keywords",
        pattern: "我的口味|我喜欢什么|画像|喝过什么|profile|口味偏好|口味画像|偏好|我的记录|品饮记录|喝过.*酒|看我口味|口味|看看.*口味",
        type: "positive",
        confidence: 0.90,
        requiresImage: false,
      },
    ],
    samples: [
      { text: "我的口味是什么", weight: 0.90, expectedIntent: "profile_query", note: "询问口味" },
      { text: "看看我的偏好", weight: 0.88, expectedIntent: "profile_query", note: "查看偏好" },
      { text: "我喝过哪些酒", weight: 0.85, expectedIntent: "profile_query", note: "历史记录" },
      { text: "帮我看看口味画像", weight: 0.88, expectedIntent: "profile_query", note: "画像查询" },
    ],
    prompt: {
      systemPrompt: "你是 Beer Lens 的口味画像查询意图识别器。当用户想了解自己的口味偏好、历史品饮记录、口味画像时匹配此意图。关键信号：我的口味、偏好、画像、喝过什么、品饮记录。边界：不是推荐酒款，不是反馈评分，不是啤酒知识问答。",
      examples: ["我的口味画像", "我喝过哪些酒", "帮我看看偏好", "我的品饮记录"],
      negativeExamples: ["推荐一款我喜欢的", "4分好喝", "IPA是什么"],
      disambiguation: "当用户同时表达查看画像和推荐需求时（如\"看看我口味，顺便推荐\"），如果查看画像是主需求则匹配为主意图。",
    },
    slots: [],
    handler: "handleProfileQuery",
    supportsImage: false,
  },

  {
    id: "beer_knowledge",
    label: "啤酒知识",
    description: "纯 LLM 回答啤酒风格、酿造工艺、酒厂、品饮知识",
    priority: 35,
    rules: [
      {
        id: "knowledge_keywords",
        pattern: "什么是|区别|为什么|怎么酿|风格|定义|解释|酿造|怎么.*做|如何.*酿|IPA.*什么|拉格.*什么|世涛.*什么|怎么样.*风格|怎么样.*酒|酒厂.*怎么|酒厂.*样|这酒.*怎么",
        type: "positive",
        confidence: 0.85,
        requiresImage: false,
      },
      // Negative: if it looks purely like a recommendation (short, only has recommend keywords)
      {
        id: "knowledge_not_pure_recommend",
        pattern: "^(推荐|帮我.*选|帮我.*挑|喝什么|帮我推荐).{0,10}$",
        type: "negative",
        confidence: 0,
        requiresImage: false,
      },
    ],
    samples: [
      { text: "IPA和拉格有什么区别", weight: 0.90, expectedIntent: "beer_knowledge", note: "风格对比" },
      { text: "什么是干投酒花", weight: 0.88, expectedIntent: "beer_knowledge", note: "酿造知识" },
      { text: "啤酒是怎么酿造的", weight: 0.85, expectedIntent: "beer_knowledge", note: "酿造工艺" },
      { text: "世涛为什么是黑色的", weight: 0.87, expectedIntent: "beer_knowledge", note: "风格知识" },
    ],
    prompt: {
      systemPrompt: "你是 Beer Lens 的啤酒知识问答意图识别器。当用户询问啤酒相关的专业知识时匹配此意图：风格定义和区别、酿造工艺、酒厂历史、品饮技巧、啤酒文化。边界：不是推荐酒款（\"推荐IPA\"不是知识），不是反馈评分，不是查询个人画像。",
      examples: ["IPA和拉格有什么区别", "什么是干投酒花", "啤酒怎么酿造的", "世涛为什么是黑的"],
      negativeExamples: ["推荐一款IPA", "帮我看看这张酒单", "4分好喝"],
      disambiguation: "当用户问\"什么是IPA\"时是知识问答，当用户说\"推荐一款IPA\"时是推荐。关键词是\"什么是/区别/为什么/怎么酿\"。",
    },
    slots: [],
    handler: "handleBeerKnowledge",
    supportsImage: false,
  },

  {
    id: "memory_correction",
    label: "记忆纠正",
    description: "用户纠正 AI 的错误记忆",
    priority: 40,
    rules: [
      {
        id: "correction_keywords",
        pattern: "不是|纠正|记错|应该是|改成|不对",
        type: "positive",
        confidence: 0.85,
        requiresImage: false,
      },
      // Negative: too vague
      {
        id: "correction_not_vague",
        pattern: "^(不是|不对|不)$",
        type: "negative",
        confidence: 0,
        requiresImage: false,
      },
    ],
    samples: [
      { text: "不是这个，应该是Green City", weight: 0.88, expectedIntent: "memory_correction", note: "纠正酒名" },
      { text: "纠正一下，我喝的是另一款", weight: 0.85, expectedIntent: "memory_correction", note: "纠正记录" },
      { text: "记错了，改成IPA吧", weight: 0.83, expectedIntent: "memory_correction", note: "修改偏好" },
    ],
    prompt: {
      systemPrompt: "你是 Beer Lens 的记忆纠正意图识别器。当用户指出 AI 之前的记忆或推荐有误时匹配此意图。关键信号：不是/纠正/记错/应该是/改成/不对。边界：不是简单的否定（\"不对\"太短不算），不是评分反馈，不是推荐请求。需要有明确的纠正对象和替换内容。",
      examples: ["不是这个，应该是Green City", "纠正一下，我喝的是另一款", "记错了，改成IPA"],
      negativeExamples: ["不", "不对", "不是"],
      disambiguation: "当用户说\"不对\"但没有指定纠正内容时不匹配此意图，退回 unclear。",
    },
    slots: [
      { name: "beerName", label: "正确酒名", type: "string", pattern: "[A-Za-z一-鿿·\\- ]{2,30}" },
    ],
    handler: "handleMemoryCorrection",
    supportsImage: false,
  },

  {
    id: "unclear",
    label: "意图不明",
    description: "无法识别意图时的兜底处理，引导用户说明需求",
    priority: 99,
    rules: [],
    samples: [],
    slots: [],
    handler: "handleUnclear",
    supportsImage: true,
  },
];

// ═══════════════════════════════════════════════════════════════
// Registration API (with persistence)
// ═══════════════════════════════════════════════════════════════

const REGISTRY_PATH = path.join(process.cwd(), "data", "intent-registry.json");

function loadCustomIntentsSync(): IntentDefinition[] {
  try {
    if (!existsSync(REGISTRY_PATH)) return [];
    const raw = readFileSync(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as IntentDefinition[];
  } catch {
    return [];
  }
}

/** Persist custom intents to disk (built-in intents are NOT saved) */
async function saveCustomIntents(): Promise<void> {
  const builtinIds = new Set<string>([
    "menu_recommend", "tasting_feedback", "profile_query",
    "beer_knowledge", "label_check", "memory_correction", "unclear",
  ]);
  const customIntents = INTENT_REGISTRY.filter(d => !builtinIds.has(d.id));
  await mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(customIntents, null, 2) + "\n", "utf8");
}

// Load custom intents synchronously on module load
for (const def of loadCustomIntentsSync()) {
  const idx = INTENT_REGISTRY.findIndex(d => d.id === def.id);
  if (idx >= 0) INTENT_REGISTRY[idx] = def;
  else INTENT_REGISTRY.push(def);
}

export function registerIntent(def: IntentDefinition): void {
  const idx = INTENT_REGISTRY.findIndex((d) => d.id === def.id);
  if (idx >= 0) INTENT_REGISTRY[idx] = def;
  else INTENT_REGISTRY.push(def);
  // Persist asynchronously
  saveCustomIntents().catch(err => console.warn("[intent-registry] failed to persist:", err));
}

export function unregisterIntent(id: BeerIntent): boolean {
  // Don't allow removing built-in intents
  const builtinIds = new Set<string>([
    "menu_recommend", "tasting_feedback", "profile_query",
    "beer_knowledge", "label_check", "memory_correction", "unclear",
  ]);
  if (builtinIds.has(id)) return false;

  const idx = INTENT_REGISTRY.findIndex((d) => d.id === id);
  if (idx >= 0) { INTENT_REGISTRY.splice(idx, 1); saveCustomIntents().catch(() => {}); return true; }
  return false;
}

export function getIntent(id: BeerIntent): IntentDefinition | undefined {
  return INTENT_REGISTRY.find((d) => d.id === id);
}

export function getAllIntents(): IntentDefinition[] {
  return [...INTENT_REGISTRY];
}

// ═══════════════════════════════════════════════════════════════
// Core classification logic
// ═══════════════════════════════════════════════════════════════

function compileRegex(pattern: string): RegExp {
  try { return new RegExp(pattern, "i"); } catch { return /(?!)/; }
}

function checkCondition(cond: RuleCondition, ctx: IntentClassifyContext): boolean {
  const val = ctx[cond.field as keyof IntentClassifyContext];
  if (val === undefined) return true; // condition not applicable → pass
  switch (cond.op) {
    case "eq": return val === cond.value;
    case "gt": return (val as number) > (cond.value as number);
    case "gte": return (val as number) >= (cond.value as number);
    case "lt": return (val as number) < (cond.value as number);
    case "lte": return (val as number) <= (cond.value as number);
    default: return true;
  }
}

export type IntentClassifyContext = {
  hasImage: boolean;
  hasActiveMenu: boolean;
  turnsSinceMenu: number;
  activeMenuCandidateCount: number;
  hasTastingHistory: boolean;
  episodeCount: number;
};

/**
 * Classify intent from text + context.
 * Returns detailed result with trace.
 */
export function classify(
  text: string,
  ctx: IntentClassifyContext,
  options?: {
    threshold?: number;
    multiIntentGap?: number;
    overrides?: Array<{ regex: string; intent: string }>;
  },
): IntentTestResult {
  const threshold = options?.threshold ?? 0.7;
  const multiIntentGap = options?.multiIntentGap ?? 0.20;
  const trace: RuleTrace[] = [];

  // ── Priority 0: User overrides ──
  if (options?.overrides) {
    for (const ov of options.overrides) {
      try {
        if (new RegExp(ov.regex, "i").test(text)) {
          const intent = ov.intent as BeerIntent;
          const def = getIntent(intent);
          return {
            input: { text, hasImage: ctx.hasImage },
            matched: [{
              intent,
              label: def?.label ?? intent,
              confidence: 1.0,
              ruleId: "override",
              source: "override",
            }],
            primary: intent,
            isMultiIntent: false,
            source: "override",
            trace: [{ intentId: intent, ruleId: "override", type: "positive", matched: true, confidence: 1.0, reason: `User override: /${ov.regex}/` }],
          };
        }
      } catch { /* invalid regex */ }
    }
  }

  // ── Build sorted intent list by priority ──
  const sortedIntents = [...INTENT_REGISTRY].sort((a, b) => a.priority - b.priority);

  // First pass: evaluate negative rules → build exclusion set
  const excludedIntents = new Set<BeerIntent>();
  for (const def of sortedIntents) {
    for (const rule of def.rules) {
      if (rule.type !== "negative") continue;
      if (rule.requiresImage && !ctx.hasImage) continue;
      const regex = compileRegex(rule.pattern);
      if (regex.test(text)) {
        // Check conditions
        if (rule.conditions && !rule.conditions.every(c => checkCondition(c, ctx))) continue;
        excludedIntents.add(def.id);
        trace.push({ intentId: def.id, ruleId: rule.id, type: "negative", matched: true, reason: `Negative rule matched: /${rule.pattern}/` });
      }
    }
  }

  // Second pass: evaluate positive rules → collect matches
  const matches: Array<{ intent: BeerIntent; label: string; confidence: number; ruleId: string; source: "positive_rule" | "sample_match" }> = [];
  const matchedIntentIds = new Set<BeerIntent>();

  for (const def of sortedIntents) {
    if (excludedIntents.has(def.id)) continue;
    if (matchedIntentIds.has(def.id)) continue; // already matched with higher priority

    for (const rule of def.rules) {
      if (rule.type !== "positive") continue;
      if (rule.requiresImage && !ctx.hasImage) continue;
      if (rule.conditions && !rule.conditions.every(c => checkCondition(c, ctx))) continue;

      const regex = compileRegex(rule.pattern);
      if (regex.test(text) && rule.confidence >= threshold) {
        matches.push({
          intent: def.id,
          label: def.label,
          confidence: rule.confidence,
          ruleId: rule.id,
          source: "positive_rule",
        });
        matchedIntentIds.add(def.id);
        trace.push({ intentId: def.id, ruleId: rule.id, type: "positive", matched: true, confidence: rule.confidence, reason: `Pattern /${rule.pattern}/ matched` });
        break; // Only first matching positive rule per intent
      } else {
        trace.push({ intentId: def.id, ruleId: rule.id, type: "positive", matched: false, reason: `Pattern /${rule.pattern}/ did not match or confidence ${rule.confidence} < ${threshold}` });
      }
    }
  }

  // ── Priority 2: Sample matching (for intents not yet matched) ──
  for (const def of sortedIntents) {
    if (matchedIntentIds.has(def.id)) continue;
    if (excludedIntents.has(def.id)) continue;
    if (!def.samples || def.samples.length === 0) continue;

    let bestSampleScore = 0;
    for (const sample of def.samples) {
      const score = keywordOverlapScore(text, sample.text) * sample.weight;
      if (score > bestSampleScore) bestSampleScore = score;
    }

    if (bestSampleScore >= threshold) {
      matches.push({
        intent: def.id,
        label: def.label,
        confidence: bestSampleScore,
        ruleId: "sample_match",
        source: "sample_match",
      });
      matchedIntentIds.add(def.id);
      trace.push({ intentId: def.id, ruleId: "sample_match", type: "positive", matched: true, confidence: bestSampleScore, reason: `Sample match score: ${bestSampleScore.toFixed(2)}` });
    }
  }

  // Sort matches by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);

  if (matches.length === 0) {
    return {
      input: { text, hasImage: ctx.hasImage },
      matched: [],
      primary: "unclear",
      isMultiIntent: false,
      source: "no_match",
      trace,
    };
  }

  const primary = matches[0].intent;

  // Multi-intent detection:
  // 1. At least 2 distinct intents matched
  // 2. The gap between 1st and 2nd is within multiIntentGap
  // 3. Each candidate has confidence >= threshold
  // 4. No contextual intents (follow_up_filter) are counted unless conditions met
  const distinctIntents = new Set(matches.map(m => m.intent));
  const isMulti = distinctIntents.size >= 2 &&
    matches.length >= 2 &&
    (matches[0].confidence - matches[1].confidence) <= multiIntentGap &&
    matches.slice(0, distinctIntents.size).every(m => m.confidence >= threshold);

  return {
    input: { text, hasImage: ctx.hasImage },
    matched: matches.map(m => ({
      intent: m.intent,
      label: m.label,
      confidence: m.confidence,
      ruleId: m.ruleId,
      source: m.source,
    })),
    primary,
    isMultiIntent: isMulti,
    source: matches[0].source === "sample_match" ? "sample" : "rule",
    trace,
  };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Simple keyword overlap score between two strings.
 * Higher = more word overlap.
 */
function keywordOverlapScore(text: string, sample: string): number {
  const textWords = new Set(text.toLowerCase().split(/\s+/));
  const sampleWords = sample.toLowerCase().split(/\s+/);
  if (sampleWords.length === 0) return 0;
  let hits = 0;
  for (const w of sampleWords) {
    // Also check substring match for Chinese
    if (textWords.has(w) || text.includes(w)) hits++;
  }
  return hits / sampleWords.length;
}

/**
 * Extract slots from text based on intent's slot definitions.
 */
export function extractSlots(
  text: string,
  intentId: BeerIntent,
): Record<string, unknown> {
  const def = getIntent(intentId);
  if (!def?.slots) return {};

  const result: Record<string, unknown> = {};
  for (const slot of def.slots) {
    if (slot.pattern) {
      const re = new RegExp(slot.pattern, "i");
      const m = text.match(re);
      if (m) {
        const val = m[1] ?? m[0];
        if (slot.type === "number") {
          result[slot.name] = parseFloat(val);
        } else {
          result[slot.name] = val;
        }
      }
    }
    if (slot.type === "enum" && slot.enumValues) {
      for (const ev of slot.enumValues) {
        if (text.includes(ev)) {
          result[slot.name] = ev;
          break;
        }
      }
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Backward-compat testIntent wrapper
// ═══════════════════════════════════════════════════════════════

export function testIntent(
  text: string,
  hasImage: boolean,
  options?: {
    hasActiveMenu?: boolean;
    turnsSinceMenu?: number;
    activeMenuCandidateCount?: number;
    hasTastingHistory?: boolean;
    episodeCount?: number;
    threshold?: number;
    multiIntentGap?: number;
  },
): IntentTestResult {
  return classify(text, {
    hasImage,
    hasActiveMenu: options?.hasActiveMenu ?? false,
    turnsSinceMenu: options?.turnsSinceMenu ?? 999,
    activeMenuCandidateCount: options?.activeMenuCandidateCount ?? 0,
    hasTastingHistory: options?.hasTastingHistory ?? false,
    episodeCount: options?.episodeCount ?? 0,
  }, {
    threshold: options?.threshold,
    multiIntentGap: options?.multiIntentGap,
  });
}
