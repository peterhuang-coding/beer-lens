import type { BeerDialogRequest, IntentContext, IntentResult, IntentItem } from "./dialog-types";
import { openrouterFetch } from "./openrouter-client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classify, extractSlots } from "./intent-registry";
import type { IntentClassifyContext } from "./intent-registry";

// ── Runtime config ──

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

type PipelineConfig = {
  config?: Record<string, Record<string, any>>;
  intentOverrides?: Array<{ regex: string; intent: string; note?: string }>;
};

let _configCache: PipelineConfig | null = null;
let _configCacheTime = 0;

async function loadPipelineConfig(): Promise<PipelineConfig> {
  if (_configCache && Date.now() - _configCacheTime < 5000) return _configCache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    _configCache = JSON.parse(raw);
    _configCacheTime = Date.now();
    return _configCache!;
  } catch {
    return {};
  }
}

export async function getNodeConfig(nodeId: string, key: string, defaultValue: any): Promise<any> {
  const cfg = await loadPipelineConfig();
  return cfg.config?.[nodeId]?.[key] ?? defaultValue;
}

// ── LLM fallback ──

async function llmClassify(
  text: string,
  ctx: IntentContext,
): Promise<IntentResult> {
  const hasImage = ctx.hasImage;

  const intentNames = "menu_recommend | tasting_feedback | profile_query | beer_knowledge | label_check | memory_correction | unclear";

  const prompt = `你是 Beer Lens 意图识别器。只输出 JSON。

用户输入：${text}
有图片：${hasImage}
有上一轮酒单：${ctx.hasLastMenuCandidates}

意图类型：${intentNames}

返回：
{"intents":[{"intent":"beer_knowledge","confidence":0.82}],"primary":"beer_knowledge","slots":{},"missingInfo":[],"routeReason":"LLM classification","source":"llm","isMultiIntent":false}`;

  try {
    const raw = await openrouterFetch({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0,
    });

    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON in LLM response");

    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as any;
    const llmIntents: IntentItem[] = (parsed.intents ?? []).map((item: any) => ({
      intent: item.intent ?? "unclear",
      confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
      slots: item.slots ?? {},
    }));

    if (llmIntents.length === 0) {
      llmIntents.push({ intent: parsed.primary ?? "unclear", confidence: 0.5, slots: parsed.slots ?? {} });
    }

    return {
      intents: llmIntents,
      intent: llmIntents[0].intent,
      confidence: llmIntents[0].confidence,
      slots: llmIntents[0].slots,
      missingInfo: parsed.missingInfo ?? [],
      routeReason: llmIntents.length > 1 ? `LLM multi-intent: ${llmIntents.map(i => i.intent).join(", ")}` : "LLM intent classification",
      source: "llm",
      isMultiIntent: llmIntents.length > 1,
    };
  } catch (err) {
    console.warn("[intent-classifier] LLM fallback failed:", err);
    return {
      intents: [{ intent: "unclear", confidence: 0.2, slots: {} }],
      intent: "unclear",
      confidence: 0.2,
      slots: {},
      missingInfo: [],
      routeReason: `LLM fallback failed: ${err instanceof Error ? err.message : "unknown error"}`,
      source: "fallback",
      isMultiIntent: false,
    };
  }
}

// ── Main entry point ──

export async function classifyIntent(
  request: BeerDialogRequest,
  context: IntentContext,
): Promise<IntentResult> {
  const text = context.lastUserText;

  // ── Build classify context from IntentContext ──
  const classifyCtx: IntentClassifyContext = {
    hasImage: context.hasImage,
    hasActiveMenu: context.hasLastMenuCandidates,
    turnsSinceMenu: context.turnsSinceLastMenu,
    activeMenuCandidateCount: context.activeMenuCandidateCount,
    hasTastingHistory: !!context.profileSummary && !context.profileSummary.includes("还没有正式记录"),
    episodeCount: 0, // Could be populated from profile
  };

  // ── Load config for thresholds and overrides ──
  const pipelineConfig = await loadPipelineConfig();
  const threshold = pipelineConfig.config?.["intent-classifier"]?.["ruleConfidenceThreshold"] ?? 0.7;
  const multiIntentGap = pipelineConfig.config?.["intent-classifier"]?.["multiIntentGap"] ?? 0.15;
  const overrides = (pipelineConfig.intentOverrides ?? [])
    .filter(o => o.regex && o.regex.trim())
    .map(o => ({ regex: o.regex, intent: o.intent }));

  // ── Run the registry classifier ──
  const result = classify(text, classifyCtx, { threshold, multiIntentGap, overrides });

  // ── If no rule/sample match, fall back to LLM ──
  if (result.source === "no_match") {
    return llmClassify(text, context);
  }

  // ── Extract slots from primary intent ──
  const slots = extractSlots(text, result.primary);

  // ── Build IntentResult ──
  const intents: IntentItem[] = result.matched.map(m => ({
    intent: m.intent,
    confidence: m.confidence,
    slots: m.intent === result.primary ? slots : extractSlots(text, m.intent),
  }));

  return {
    intents,
    intent: result.primary,
    confidence: result.matched[0]?.confidence ?? 0,
    slots,
    missingInfo: [],
    routeReason: result.isMultiIntent
      ? `Multi-intent: ${intents.map(i => `${i.intent}(${(i.confidence*100).toFixed(0)}%)`).join(", ")}`
      : `${result.source} match: ${result.primary} (${(result.matched[0]?.confidence ?? 0 * 100).toFixed(0)}%)`,
    source: result.source === "override" || result.source === "sample" ? "rule" : result.source as "rule" | "llm" | "fallback",
    isMultiIntent: result.isMultiIntent,
  };
}
