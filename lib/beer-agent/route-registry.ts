/**
 * Route Registry — "意图 → 技能/工具/handler" 路由表和诊断闭环。
 *
 * 每个 route 定义：
 *   - intent, handler, requiredContext, requiredTools
 *   - priority, fallbackIntent/fallbackReply, enabled, notes
 *
 * 路由诊断输出：
 *   - selectedHandler, requiredContextMatched, missingContext
 *   - requiredTools, fallbackUsed, routeReason
 *
 * 可配置：可通过 pipeline-config.json 的 routes 分区覆盖和扩展。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ContextKey = "hasImage" | "lastMenu" | "activeBeer" | "profileSummary" | "tastingHistory";

export type RouteDefinition = {
  /** Primary intent id that triggers this route */
  intent: string;
  /** Handler function name */
  handler: string;
  /** Context that must be present for this route to function well */
  requiredContext: ContextKey[];
  /** Tools consumed by this route */
  requiredTools: string[];
  /** Priority (lower = higher priority, for ordering display) */
  priority: number;
  /** Fallback intent if required context is missing */
  fallbackIntent?: string;
  /** Fallback reply if the handler or route can't proceed */
  fallbackReply: string;
  /** Whether this route is enabled */
  enabled: boolean;
  /** Human-readable notes */
  notes: string;
};

export type RouteDiagnosis = {
  /** Which handler was ultimately selected */
  selectedHandler: string;
  /** Which required context keys were present */
  requiredContextMatched: ContextKey[];
  /** Which required context keys were missing */
  missingContext: ContextKey[];
  /** Tools listed in the route definition */
  requiredTools: string[];
  /** Whether a fallback was used */
  fallbackUsed: boolean;
  /** Why this route was chosen (or why fallback was used) */
  routeReason: string;
  /** The intent that triggered routing */
  intent: string;
  /** The fallback intent used (if any) */
  fallbackIntent?: string;
};

// ═══════════════════════════════════════════════════════════════
// Built-in Route Table
// ═══════════════════════════════════════════════════════════════

const BUILTIN_ROUTES: RouteDefinition[] = [
  {
    intent: "menu_recommend",
    handler: "handleMenuRecommend",
    requiredContext: ["hasImage"],
    requiredTools: ["vision_pipeline", "beer_db_lookup", "recommendation_scoring"],
    priority: 10,
    fallbackReply: "请发一张酒单照片，或者直接告诉我酒名，我帮你推荐。",
    enabled: true,
    notes: "拍酒单推荐：图片走 vision_pipeline → beer_db_lookup → recommendation_scoring。无图片时走文本模式（resolveBeerCandidates）。有活跃菜单 + 追问关键词时内部分流到 follow-up 路径。",
  },
  {
    intent: "follow_up_filter",
    handler: "handleFollowUpFilter",
    requiredContext: ["lastMenu"],
    requiredTools: ["memory_profile"],
    priority: 12,
    fallbackIntent: "menu_recommend",
    fallbackReply: "我现在没有上一张酒单上下文，你发一下酒单或告诉我酒名，我再帮你筛。",
    enabled: true,
    notes: "酒单追问：基于 short-term memory 中上轮酒单候选做过滤/重排。缺少 lastMenu 时 fallback 到 menu_recommend 提示用户先发酒单。",
  },
  {
    intent: "tasting_feedback",
    handler: "handleTastingFeedback",
    requiredContext: ["activeBeer"],
    requiredTools: ["memory_profile"],
    priority: 20,
    fallbackReply: "你说的是哪一款酒？可以告诉我序号（比如'第3个'）或者酒名，我帮你记录。",
    enabled: true,
    notes: "品饮反馈：解析评分(1-5分)、是否再喝、风味标签 → 写入 episodic memory → 重建口味画像。无 activeBeer 时追问是哪一款。",
  },
  {
    intent: "profile_query",
    handler: "handleProfileQuery",
    requiredContext: [],
    requiredTools: ["memory_profile"],
    priority: 25,
    fallbackReply: "你还没有品饮记录，先喝几杯再告诉我感受，我就能帮你分析口味画像了。",
    enabled: true,
    notes: "画像查询：读取 ProfileMemory (偏好风格/标签/ABV 区间)，返回结构化口味画像总结。无品饮记录时给出引导回复。",
  },
  {
    intent: "beer_knowledge",
    handler: "handleBeerKnowledge",
    requiredContext: [],
    requiredTools: [],
    priority: 35,
    fallbackReply: "抱歉，回答这个问题时出错了。请再试一次。",
    enabled: true,
    notes: "啤酒知识：纯 LLM 回答。不查数据库，不编造酒名。LLM 调用失败时有 catch fallback。",
  },
  {
    intent: "label_check",
    handler: "handleLabelCheck",
    requiredContext: ["hasImage"],
    requiredTools: ["vision_pipeline"],
    priority: 15,
    fallbackReply: "请发一张酒标/酒瓶照片给我，我帮你检查日期和新鲜度。",
    enabled: true,
    notes: "酒标检查：有图片时走 vision model 识别酒名+日期+新鲜度。无图片时用 LLM 聊天式回答。",
  },
  {
    intent: "memory_correction",
    handler: "handleMemoryCorrection",
    requiredContext: [],
    requiredTools: ["memory_profile"],
    priority: 40,
    fallbackReply: "我不太确定你想纠正什么。你可以说「我不是不喜欢IPA，我是不喜欢太苦的」或「我其实喜欢酸啤」来帮我调整口味画像。",
    enabled: true,
    notes: "记忆纠正：解析纠正意图 → 写入 corrections → 重建 profile。无法解析纠正内容时给出引导。",
  },
  {
    intent: "unclear",
    handler: "handleUnclear",
    requiredContext: [],
    requiredTools: [],
    priority: 99,
    fallbackReply: "你是想推荐啤酒、记录喝过的酒，还是了解啤酒知识？",
    enabled: true,
    notes: "意图不明：根据是否有图片发不同追问，引导用户说明需求。",
  },
];

// ═══════════════════════════════════════════════════════════════
// Registry — merge built-in + pipeline-config.json routes
// ═══════════════════════════════════════════════════════════════

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

function loadConfigRoutes(): RouteDefinition[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg.routes || !Array.isArray(cfg.routes)) return [];
    return cfg.routes as RouteDefinition[];
  } catch {
    return [];
  }
}

let _routeTable: RouteDefinition[] | null = null;

/** Get the merged route table (built-in + config overrides). */
export function getRouteTable(): RouteDefinition[] {
  if (_routeTable) return _routeTable;

  const configRoutes = loadConfigRoutes();
  const merged = new Map<string, RouteDefinition>();

  // Load built-ins first
  for (const r of BUILTIN_ROUTES) {
    merged.set(r.intent, { ...r });
  }

  // Override with config routes (by intent key)
  for (const r of configRoutes) {
    merged.set(r.intent, { ...r });
  }

  _routeTable = Array.from(merged.values()).sort((a, b) => a.priority - b.priority);
  return _routeTable;
}

/** Reload route table (used after config change). */
export function reloadRouteTable(): void {
  _routeTable = null;
}

/** Get a single route by intent id. */
export function getRoute(intent: string): RouteDefinition | undefined {
  return getRouteTable().find((r) => r.intent === intent);
}

// ═══════════════════════════════════════════════════════════════
// Route Diagnosis
// ═══════════════════════════════════════════════════════════════

export type RouteContextSnapshot = {
  hasImage: boolean;
  lastMenu: boolean;
  activeBeer: boolean;
  profileSummary: boolean;
  tastingHistory: boolean;
};

/**
 * Perform route diagnosis: given an intent and available context,
 * determine which handler to use, whether fallback is needed, and why.
 */
export function diagnoseRoute(
  intent: string,
  context: RouteContextSnapshot,
): RouteDiagnosis {
  const route = getRoute(intent);

  // ── No route found → fallback to unclear ──
  if (!route || !route.enabled) {
    const unclearRoute = getRoute("unclear");
    return {
      selectedHandler: unclearRoute?.handler ?? "handleUnclear",
      requiredContextMatched: [],
      missingContext: [],
      requiredTools: [],
      fallbackUsed: true,
      routeReason: route
        ? `Route "${intent}" is disabled, falling back to unclear`
        : `No route registered for intent "${intent}", falling back to unclear`,
      intent,
      fallbackIntent: "unclear",
    };
  }

  // ── Check required context ──
  const contextMap: Record<ContextKey, boolean> = {
    hasImage: context.hasImage,
    lastMenu: context.lastMenu,
    activeBeer: context.activeBeer,
    profileSummary: context.profileSummary,
    tastingHistory: context.tastingHistory,
  };

  const matched: ContextKey[] = [];
  const missing: ContextKey[] = [];

  for (const key of route.requiredContext) {
    if (contextMap[key]) {
      matched.push(key);
    } else {
      missing.push(key);
    }
  }

  // ── Context fully satisfied → direct route ──
  if (missing.length === 0) {
    return {
      selectedHandler: route.handler,
      requiredContextMatched: matched,
      missingContext: [],
      requiredTools: [...route.requiredTools],
      fallbackUsed: false,
      routeReason: `Intent "${intent}" matched route "${route.handler}" — all required context present`,
      intent,
    };
  }

  // ── Context missing but has fallbackIntent → try fallback route ──
  if (route.fallbackIntent) {
    const fallbackRoute = getRoute(route.fallbackIntent);
    return {
      selectedHandler: fallbackRoute?.handler ?? route.handler,
      requiredContextMatched: matched,
      missingContext: missing,
      requiredTools: [...route.requiredTools],
      fallbackUsed: true,
      routeReason: `Intent "${intent}" missing context [${missing.join(", ")}] → falling back to "${route.fallbackIntent}"`,
      intent,
      fallbackIntent: route.fallbackIntent,
    };
  }

  // ── Context missing, no fallbackIntent → use handler with fallbackReply ──
  return {
    selectedHandler: route.handler,
    requiredContextMatched: matched,
    missingContext: missing,
    requiredTools: [...route.requiredTools],
    fallbackUsed: true,
    routeReason: `Intent "${intent}" missing context [${missing.join(", ")}] — proceeding with fallbackReply`,
    intent,
  };
}