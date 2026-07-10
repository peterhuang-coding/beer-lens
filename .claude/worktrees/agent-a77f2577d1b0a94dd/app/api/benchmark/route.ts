import { NextResponse } from "next/server";
import { openrouterFetch } from "@/lib/beer-agent/openrouter-client";
import { testIntent, getAllIntents } from "@/lib/beer-agent/intent-registry";
import { getMetricsSnapshot } from "@/lib/beer-agent/monitor/metrics";
import { getDatabaseStats } from "@/lib/beer-agent/beer-db/updater";
import { getFactors } from "@/lib/beer-agent/memory/factor/extraction";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

type BenchResult = {
  id: string;
  name: string;
  node: string;
  status: "pass" | "warn" | "fail";
  latencyMs: number;
  detail: string;
  suggestion?: string;
};

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const results: BenchResult[] = [];
  const t0 = Date.now();

  // ── 1. OpenRouter connectivity ──
  const t1 = Date.now();
  try {
    const raw = await openrouterFetch({
      model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "Say 'OK' only, no other text." }],
      max_tokens: 10,
      temperature: 0,
    });
    const ok = raw.trim().toUpperCase().includes("OK");
    results.push({
      id: "openrouter",
      name: "OpenRouter 连接",
      node: "openrouter",
      status: ok ? "pass" : "warn",
      latencyMs: Date.now() - t1,
      detail: ok ? "GPT-4o-mini 正常响应" : `响应异常: ${raw.slice(0, 50)}`,
    });
  } catch (err) {
    results.push({
      id: "openrouter",
      name: "OpenRouter 连接",
      node: "openrouter",
      status: "fail",
      latencyMs: Date.now() - t1,
      detail: `连接失败: ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`,
      suggestion: "检查 OPENROUTER_API_KEY 和网络连接",
    });
  }

  // ── 2. Vision model (Gemini Flash) ──
  const t2 = Date.now();
  try {
    const raw = await openrouterFetch({
      model: process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash",
      messages: [{ role: "user", content: "Say 'OK' only, no other text." }],
      max_tokens: 10,
      temperature: 0,
    });
    results.push({
      id: "vision-model",
      name: "视觉模型",
      node: "vision-pipeline",
      status: "pass",
      latencyMs: Date.now() - t2,
      detail: `${process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash"} 正常响应`,
    });
  } catch (err) {
    results.push({
      id: "vision-model",
      name: "视觉模型",
      node: "vision-pipeline",
      status: "fail",
      latencyMs: Date.now() - t2,
      detail: `失败: ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`,
      suggestion: "检查 OPENROUTER_VISION_MODEL 配置",
    });
  }

  // ── 3. Intent accuracy ──
  // Each case: [text, hasImage, expectedIntent | "multi", expectedIntents?]
  // For "multi", we also validate that ALL expected intents are present in matched[]
  const t3 = Date.now();
  const intentCases: Array<{ text: string; hasImage: boolean; expected: string; expectedMulti?: string[]; context?: Record<string, any> }> = [
    // ── Single intent: menu_recommend ──
    { text: "推荐一款IPA", hasImage: false, expected: "menu_recommend" },
    { text: "帮我推荐", hasImage: false, expected: "menu_recommend" },
    { text: "有什么推荐的", hasImage: false, expected: "menu_recommend" },
    { text: "今天喝什么好", hasImage: false, expected: "menu_recommend" },
    { text: "帮我看看这张酒单", hasImage: true, expected: "menu_recommend" },
    { text: "想喝点清爽的", hasImage: false, expected: "menu_recommend" },
    { text: "帮我选一款", hasImage: false, expected: "menu_recommend" },

    // ── Single intent: label_check ──
    { text: "这瓶酒的生产日期", hasImage: true, expected: "label_check" },
    { text: "酒标帮我看看", hasImage: true, expected: "label_check" },
    { text: "看看过期没", hasImage: true, expected: "label_check" },

    // ── Single intent: tasting_feedback ──
    { text: "4分会再喝，柑橘味", hasImage: false, expected: "tasting_feedback" },
    { text: "3.5分，不会再喝", hasImage: false, expected: "tasting_feedback" },
    { text: "喝了Green City，给4分", hasImage: false, expected: "tasting_feedback" },
    // NOTE: "4分，推荐一款IPA" has rating AND recommend — should be multi, see multi cases below

    // ── Single intent: profile_query ──
    { text: "我的口味", hasImage: false, expected: "profile_query" },
    { text: "帮我看看我喝过什么", hasImage: false, expected: "profile_query" },
    { text: "我的品饮记录", hasImage: false, expected: "profile_query" },

    // ── Single intent: beer_knowledge ──
    { text: "什么是IPA", hasImage: false, expected: "beer_knowledge" },
    { text: "拉格和皮尔森区别", hasImage: false, expected: "beer_knowledge" },
    { text: "IPA为什么苦", hasImage: false, expected: "beer_knowledge" },

    // ── Single intent: memory_correction ──
    { text: "纠正一下，不是这个", hasImage: false, expected: "memory_correction" },
    { text: "记错了，应该是Green City", hasImage: false, expected: "memory_correction" },

    // ── Single intent: menu_recommend (follow-up pattern with active menu) ──
    { text: "有IPA吗", hasImage: false, expected: "menu_recommend", context: { hasActiveMenu: true, turnsSinceMenu: 5 } },
    { text: "第3个怎么样", hasImage: false, expected: "menu_recommend", context: { hasActiveMenu: true, turnsSinceMenu: 10 } },
    { text: "有没有不苦的", hasImage: false, expected: "menu_recommend", context: { hasActiveMenu: true, turnsSinceMenu: 3 } },
    { text: "哪个最便宜", hasImage: false, expected: "menu_recommend", context: { hasActiveMenu: true, turnsSinceMenu: 8 } },

    // ── Single intent: unclear ──
    { text: "hello", hasImage: false, expected: "unclear" },
    { text: "谢谢", hasImage: false, expected: "unclear" },
    { text: "第三号怎么样", hasImage: false, expected: "unclear" },

    // ── Multi-intent: feedback + recommend ──
    { text: "4分，推荐一款IPA", hasImage: false, expected: "multi", expectedMulti: ["tasting_feedback", "menu_recommend"] },
    { text: "4分，再推荐一款IPA", hasImage: false, expected: "multi", expectedMulti: ["tasting_feedback", "menu_recommend"] },
    { text: "喝了Green City，4.5分，顺便推荐下一杯", hasImage: false, expected: "multi", expectedMulti: ["tasting_feedback", "menu_recommend"] },

    // ── Multi-intent: recommend + profile ──
    { text: "帮我推荐一款IPA，顺便看我口味", hasImage: false, expected: "multi", expectedMulti: ["menu_recommend", "profile_query"] },

    // ── Multi-intent: recommend + knowledge ──
    { text: "推荐一款IPA，IPA到底是什么风格", hasImage: false, expected: "multi", expectedMulti: ["menu_recommend", "beer_knowledge"] },

    // ── Multi-intent: label_check + recommend (with image) ──
    { text: "帮我看看酒标，顺便推荐", hasImage: true, expected: "multi", expectedMulti: ["label_check", "menu_recommend"] },

    // ── Multi-intent: label_check + knowledge ──
    { text: "看看这瓶酒标，这酒厂怎么样", hasImage: true, expected: "multi", expectedMulti: ["label_check", "beer_knowledge"] },

    // ── Multi-intent: recommend + profile (with active menu, follow-up pattern) ──
    { text: "不苦的有没有，顺便看看我口味", hasImage: false, expected: "multi", expectedMulti: ["menu_recommend", "profile_query"], context: { hasActiveMenu: true, turnsSinceMenu: 5 } },

    // ── Multi-intent: recommend + correction ──
    { text: "不是这个，推荐一款IPA给我", hasImage: false, expected: "multi", expectedMulti: ["memory_correction", "menu_recommend"] },

    // ── NOT multi: pure recommend despite short ambiguous text ──
    { text: "给我推荐个清爽的", hasImage: false, expected: "menu_recommend" },
    { text: "帮我看看酒单", hasImage: true, expected: "menu_recommend" },
  ];
  let intentPass = 0;
  let intentFail = 0;
  const intentErrors: string[] = [];
  for (const { text, hasImage, expected, expectedMulti, context } of intentCases) {
    const result = testIntent(text, hasImage, context);
    let ok: boolean;
    if (expected === "multi") {
      // Multi-intent: must be isMultiIntent, have >=2 matched, AND all expectedMulti intents are present
      const matchedIds = new Set<string>(result.matched.map(m => m.intent as string));
      const allExpected = expectedMulti ? expectedMulti.every(id => matchedIds.has(id)) : result.matched.length >= 2;
      ok = result.isMultiIntent && result.matched.length >= 2 && allExpected;
    } else {
      ok = result.primary === expected;
    }
    if (ok) intentPass++;
    else {
      intentFail++;
      const matchedStr = result.matched.map(m => `${m.intent}(${(m.confidence*100).toFixed(0)}%)`).join(", ");
      intentErrors.push(`"${text}" → primary=${result.primary}, isMulti=${result.isMultiIntent}, matched=[${matchedStr}] (expected ${expected}${expectedMulti ? ` [${expectedMulti.join(",")}]` : ""})`);
    }
  }
  results.push({
    id: "intent-accuracy",
    name: "意图识别准确率",
    node: "intent-classifier",
    status: intentFail === 0 ? "pass" : intentFail <= 3 ? "warn" : "fail",
    latencyMs: Date.now() - t3,
    detail: `${intentPass}/${intentPass + intentFail} 通过${intentFail > 0 ? `，失败: ${intentErrors.slice(0, 3).join("; ")}` : ""}`,
    suggestion: intentFail > 0 ? "检查 intent-registry.ts 规则配置" : undefined,
  });

  // ── 4. Beer DB stats ──
  const t4 = Date.now();
  try {
    const stats = await getDatabaseStats();
    results.push({
      id: "beer-db",
      name: "啤酒数据库",
      node: "beer-db",
      status: stats.totalBeers > 1000 ? "pass" : "warn",
      latencyMs: Date.now() - t4,
      detail: `${stats.totalBeers} 款啤酒，${stats.untappdCached} 条 Untappd 缓存`,
      suggestion: stats.totalBeers < 1000 ? "数据库可能损坏，检查 .beer-data/beer.db" : undefined,
    });
  } catch (err) {
    results.push({
      id: "beer-db",
      name: "啤酒数据库",
      node: "beer-db",
      status: "fail",
      latencyMs: Date.now() - t4,
      detail: `查询失败: ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`,
      suggestion: "检查 .beer-data/beer.db 和 Python3 环境",
    });
  }

  // ── 5. Memory system ──
  const t5 = Date.now();
  try {
    const factors = await getFactors("local-user");
    results.push({
      id: "memory-system",
      name: "记忆系统",
      node: "memory",
      status: "pass",
      latencyMs: Date.now() - t5,
      detail: `${factors.length} 条 Factor 事实`,
    });
  } catch (err) {
    results.push({
      id: "memory-system",
      name: "记忆系统",
      node: "memory",
      status: "warn",
      latencyMs: Date.now() - t5,
      detail: `读取失败: ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`,
    });
  }

  // ── 6. Intent registry integrity ──
  const intents = getAllIntents();
  const requiredIntents = ["menu_recommend", "label_check", "tasting_feedback", "beer_knowledge"];
  const missingRequired = requiredIntents.filter(id => !intents.find(i => i.id === id));
  const intentsWithRules = intents.filter(i => i.rules.length > 0).length;

  results.push({
    id: "intent-registry",
    name: "意图注册表",
    node: "intent-registry",
    status: missingRequired.length === 0 && intentsWithRules >= 4 ? "pass" : "fail",
    latencyMs: 0,
    detail: `${intents.length} 个意图，${intentsWithRules} 个有规则${missingRequired.length > 0 ? `，缺少核心意图: ${missingRequired.join(", ")}` : ""}`,
    suggestion: missingRequired.length > 0 ? "核心意图被删除，需要恢复" : undefined,
  });

  // ── Summary ──
  const totalMs = Date.now() - t0;
  const passCount = results.filter(r => r.status === "pass").length;
  const warnCount = results.filter(r => r.status === "warn").length;
  const failCount = results.filter(r => r.status === "fail").length;
  const healthScore = Math.round((passCount / results.length) * 100);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    totalMs,
    healthScore,
    summary: `${passCount} pass, ${warnCount} warn, ${failCount} fail — 健康度 ${healthScore}%`,
    results,
    metrics: getMetricsSnapshot(),
  });
}
