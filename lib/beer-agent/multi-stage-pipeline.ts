import { openrouterFetch } from "./openrouter-client";
import { vision } from "@/lib/multimodal";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ── Config helpers (inlined to avoid circular imports) ──

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

type ModelConfig = { provider: string; model: string; temperature: number; maxTokens: number; timeoutMs: number };

async function loadConfig(): Promise<any> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch { return {}; }
}

async function getModelConfig(kind: string): Promise<ModelConfig> {
  const cfg = await loadConfig();
  const fromConfig = cfg.models?.[kind];
  const defaults: Record<string, ModelConfig> = {
    vision:    { provider: "openrouter", model: "google/gemini-2.5-flash", temperature: 0.1, maxTokens: 12000, timeoutMs: 45000 },
    analysis:  { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0.3, maxTokens: 1500,  timeoutMs: 20000 },
  };
  if (fromConfig && typeof fromConfig === "object" && fromConfig.model) {
    return fromConfig as ModelConfig;
  }
  if (typeof fromConfig === "string" && fromConfig) {
    return { ...defaults[kind], model: fromConfig };
  }
  return defaults[kind];
}

/** Default vision fallback chain. Tried in order when the primary model
 *  fails (timeout / upstream 5xx / parse error). Override via env var
 *  `VISION_FALLBACK_MODELS="model1,model2,model3"` or by editing this
 *  array. The full chain is logged to the dev console on each image
 *  pipeline run. */
export const DEFAULT_VISION_FALLBACK: string[] = [
  "openai/gpt-4o-mini",
];

export function getVisionFallbackChain(): string[] {
  const envChain = process.env.VISION_FALLBACK_MODELS;
  if (envChain) {
    const list = envChain.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return DEFAULT_VISION_FALLBACK;
}

// ── Progress callback ──

export type PipelineEvent =
  | { type: "stage_start"; stage: string; label: string; model: string }
  | { type: "stage_done"; stage: string; durationMs: number }
  | { type: "stage_error"; stage: string; error: string }
  | { type: "enrich_start"; count: number }
  | { type: "enrich_progress"; done: number; total: number; label: string }
  | { type: "enrich_done" };

export type ProgressCallback = (event: PipelineEvent) => void;

// ── Stage output types ──

export type ImageContext = {
  imageType: "menu" | "tap_list" | "bottle" | "can" | "glass" | "venue" | "unknown";
  confidence: number;
  reason: string;
  needsOcr: boolean;
  needsLabelRecognition: boolean;
  canAssessVisualQuality: boolean;
  visibleClues: string[];
};

export type ExtractedItem = {
  menuIndex: number;
  rawText: string;
  beerName: string;
  brewery: string;
  style: string;
  abv: number;
  ibu: number | null;
  price: number | null;
  serving: string;
  packagingDate: string;
  confidence: number;
};

export type BeerSignal = {
  sourceType: string;
  rawText: string;
  items: ExtractedItem[];
  visualBeerDescription: {
    color: string;
    clarity: string;
    foam: string;
    visiblePackagingDate: string;
    notes: string[];
  };
  uncertainties: string[];
};

export type VisualQuality = {
  canAssess: boolean;
  visualRiskFlags: string[];
  oxidationRisk: "low" | "medium" | "high" | "unknown";
  freshnessRisk: "low" | "medium" | "high" | "unknown";
  lightstrikeRisk: "low" | "medium" | "high" | "unknown";
  evidence: string[];
  caveat: string;
};

export type PipelineRecommendation = {
  reply: string;
  topPickId: string;
  safePickId: string;
  explorePickId: string;
  avoidPickId: string;
  topReason: string;
  safeReason: string;
  exploreReason: string;
  avoidReason: string;
};

export type PipelineResult = {
  imageContext: ImageContext | null;
  extracted: BeerSignal | null;
  visualQuality: VisualQuality | null;
  recommendation: PipelineRecommendation;
};

// ── Defaults for text-only ──

function textOnlyImageContext(): ImageContext {
  return {
    imageType: "unknown",
    confidence: 0,
    reason: "No image provided; text-only input.",
    needsOcr: false,
    needsLabelRecognition: false,
    canAssessVisualQuality: false,
    visibleClues: [],
  };
}

function textOnlyVisualQuality(): VisualQuality {
  return {
    canAssess: false,
    visualRiskFlags: ["low_confidence"],
    oxidationRisk: "unknown",
    freshnessRisk: "unknown",
    lightstrikeRisk: "unknown",
    evidence: [],
    caveat: "No image provided.",
  };
}

function noBeerReply(ctx: ImageContext): string {
  const type = ctx?.imageType ?? "unknown";
  switch (type) {
    case "tap_list":
      return "这张照片我识别为酒头/黑板菜单，但没能从上面读出任何啤酒。可能是文字太小、反光、或者角度太偏。试试正面拍一张清楚点的？";
    case "menu":
      return "这张照片看起来是酒单，但我没能从上面识别出任何啤酒。可能是分辨率不够或者光线不好，换个角度近一点再拍试试？";
    case "bottle":
    case "can":
      return "我看到瓶子/罐子了，但没能从酒标上读出酒名和酒厂。试试拍清楚酒标正面？";
    case "glass":
      return "这杯酒看起来不错，但从酒液本身我没法知道它具体是哪款。如果想知道，可以拍酒单或者直接告诉我酒名。";
    case "venue":
      return "这是酒吧环境/货架照片，我没法直接从中提取酒单。试试对准菜单或者 tap list 拍一张？";
    default:
      return "这张图里我没能识别出任何啤酒。如果你有酒单照片，试试拍清楚一点发给我，或者直接把酒名打字发过来也行。";
  }
}

// ── Main pipeline ──

export async function runMultiStagePipeline(params: {
  apiKey: string;
  imageDataUrl: string | null;
  userText: string;
  profile: string;
  onProgress?: ProgressCallback;
}): Promise<PipelineResult> {
  const { apiKey, imageDataUrl, userText, profile, onProgress } = params;
  const visionCfg = await getModelConfig("vision");
  const analysisCfg = await getModelConfig("analysis");
  const visionModel = visionCfg.model;
  const analysisModel = analysisCfg.model;

  const emit = onProgress ?? (() => {});

  if (!imageDataUrl) {
    // Text-only path
    const imageContext = textOnlyImageContext();
    const extracted = await withProgress(emit, "ocr", "📝 文本实体抽取", analysisModel,
      () => extractBeerFromText(apiKey, analysisModel, userText));
    const visualQuality = textOnlyVisualQuality();
    const recommendation = await withProgress(emit, "recommendation", "🧠 智能推荐分析", analysisModel,
      () => analyzeRecommendation(apiKey, analysisModel, extracted, imageContext, visualQuality, profile, userText));
    return { imageContext, extracted, visualQuality, recommendation };
  }

  // Stage 1: Combined vision analysis (classify + OCR + quality) — single API call
  // Routed through the multimodal container; visionModel/apiKey are now
  // resolved inside the container from capability defaults + env.
  const combined = await withProgress(emit, "vision", "🔍📝🔬 视觉分析 (分类+OCR+质量)", visionModel,
    () => combinedVisionAnalysis(apiKey, visionModel, imageDataUrl, userText));

  const imageContext = combined.imageContext;
  const extracted = combined.extracted;
  const visualQuality = combined.visualQuality;

  // Short-circuit: no beers found
  if ((extracted.items ?? []).length === 0) {
    return {
      imageContext,
      extracted,
      visualQuality: {
        canAssess: false, visualRiskFlags: [],
        oxidationRisk: "unknown", freshnessRisk: "unknown", lightstrikeRisk: "unknown",
        evidence: [], caveat: "未识别到酒款，跳过视觉质量检查。",
      },
      recommendation: {
        reply: noBeerReply(imageContext),
        topPickId: "", safePickId: "", explorePickId: "", avoidPickId: "",
        topReason: "", safeReason: "", exploreReason: "", avoidReason: "",
      },
    };
  }

  // Stage 2: Recommendation (text model)
  const recommendation = await withProgress(emit, "recommendation", "🧠 智能推荐分析", analysisModel,
    () => analyzeRecommendation(apiKey, analysisModel, extracted, imageContext, visualQuality, profile, userText));

  return { imageContext, extracted, visualQuality, recommendation };
}

async function withProgress<T>(
  emit: ProgressCallback,
  stage: string,
  label: string,
  model: string,
  fn: () => Promise<T>
): Promise<T> {
  emit({ type: "stage_start", stage, label, model });
  const t0 = Date.now();
  try {
    const result = await fn();
    emit({ type: "stage_done", stage, durationMs: Date.now() - t0 });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "stage_error", stage, error: message });
    throw err;
  }
}

// ── Combined vision analysis: classify + OCR + quality (single call) ──

type CombinedVisionOutput = {
  imageContext: ImageContext;
  extracted: BeerSignal;
  visualQuality: VisualQuality;
};

function combinedVisionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["imageContext", "extracted", "visualQuality"],
    properties: {
      imageContext: imageContextSchema(),
      extracted: beerSignalExtractSchema(),
      visualQuality: visualQualitySchema(),
    },
  };
}

async function combinedVisionAnalysis(
  _apiKey: string, _model: string, imageDataUrl: string, userText: string
): Promise<CombinedVisionOutput> {
  const { base64, mime } = parseDataUrl(imageDataUrl);
  const schema = combinedVisionSchema();
  const visionPrompt = `你是啤酒图像分析器。一次完成以下三项任务，返回完整 JSON。

## 任务1: imageContext — 图片分类
判断图片类型：menu(酒单) / tap_list(酒头列表) / bottle(瓶) / can(罐) / glass(杯中酒) / venue(环境) / unknown

## 任务2: extracted — 提取所有啤酒
从图中抽取每款酒：beerName(酒名)、brewery(酒厂)、style(风格)、abv、ibu、price(元, 数字)、serving(容量, 如330ml)
- 不确定就降低 confidence，不要编造
- rawText 保留 OCR 原文

## 任务3: visualQuality — 视觉质量风险
- 杯中酒：氧化/老化迹象、泡沫、浑浊度
- 瓶/罐：是否能看到日期、包装受损
- 酒单/tap list：日期可见性、IPA 新鲜度风险
- 只能说是"疑似风险"，不能下结论

用户补充需求：${userText}`;

  // Route through the multimodal container — it owns fallback, cache,
  // tracing, and rule-engine hooks. apiKey/model come from env/config
  // inside the container, so we drop them here.
  const result = await vision.call<CombinedVisionOutput>("beer_menu_image", {
    image: { base64, mime },
    prompt: visionPrompt,
    schema,
    schemaName: "beer_combined_vision",
    maxTokens: 12000,
  });

  const data = result.parsed as any;
  return {
    imageContext: data?.imageContext ?? textOnlyImageContext(),
    extracted: data?.extracted ?? { sourceType: "unknown", rawText: "", items: [], visualBeerDescription: { color: "", clarity: "", foam: "", visiblePackagingDate: "", notes: [] }, uncertainties: [] },
    visualQuality: data?.visualQuality ?? textOnlyVisualQuality(),
  };
}

/** Strip "data:image/jpeg;base64," prefix to plain {base64, mime}. */
function parseDataUrl(dataUrl: string): { base64: string; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return { base64: dataUrl, mime: "image/jpeg" };
  return { base64: m[2], mime: m[1] };
}

// ── Text-only extraction ──

async function extractBeerFromText(
  apiKey: string, model: string, userText: string
): Promise<BeerSignal> {
  const schema = beerSignalExtractSchema();
  const result = await callOpenRouterJson(apiKey, model, [
    { role: "user", content: `你是啤酒实体抽取器。从以下文本中抽取啤酒候选项（酒名、酒厂、风格、ABV、价格、容量），不确定不要编造：

${userText}

输出 rawText 为原文，items 为抽取的候选项列表。` }
  ], schema, "beer_signal_extract", 1200);
  return result as BeerSignal;
}

// ── Recommendation ──

async function analyzeRecommendation(
  apiKey: string, model: string,
  extracted: BeerSignal, imageContext: ImageContext,
  visualQuality: VisualQuality, profile: string, userText: string
): Promise<PipelineRecommendation> {
  const beerList = (extracted.items ?? []).map((item, i) =>
    `#${item.menuIndex || i + 1} ${item.beerName} | ${item.brewery || "?"} | ${item.style || "?"} | ${item.abv}% ABV` +
    (item.price ? ` | ¥${item.price}` : "") +
    (item.serving ? ` | ${item.serving}` : "")
  ).join("\n");

  const schema = recommendationSchema();
  const result = await callOpenRouterJson(apiKey, model, [
    { role: "system", content: `你是 Beer Lens，一个懂啤酒、懂个人口味的推荐 agent。

必须用中文回答。

CRITICAL RULES:
- 你只能从下面提供的 OCR 酒单中做推荐
- topPickId/safePickId/explorePickId/avoidPickId 必须是 OCR 酒单里的 menuIndex 数字（转为字符串）
- reply 写一句中文推荐语，不要编造酒名

用户画像：
${profile}` },
    { role: "user", content: `OCR 酒单:
${beerList}

用户需求: ${userText || "帮我看这张酒单并推荐"}

图片类型: ${JSON.stringify(imageContext)}
风险: ${JSON.stringify(visualQuality?.visualRiskFlags ?? [])}

请选出 top/safe/explore/avoid 四个推荐，用 menuIndex 数字做 ID。` }
  ], schema, "beer_recommendation", 1200);
  return result as PipelineRecommendation;
}

// ── OpenRouter JSON call ──

async function callOpenRouterJson(
  _apiKey: string, model: string,
  messages: object[], schema: object, schemaName: string, maxTokens: number
): Promise<object> {
  const schemaJson = JSON.stringify(schema);
  const buildBody = (m: string): any => {
    const supportsJsonSchema = !m.includes("gemini");
    const b: any = {
      model: m,
      messages: messages.map((msg: any) => {
        if (typeof msg.content === "string") {
          return {
            ...msg,
            content: `${msg.content}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}`,
          };
        }
        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part: any) =>
              part.type === "text"
                ? { ...part, text: `${part.text}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}` }
                : part
            ),
          };
        }
        return msg;
      }),
      temperature: 0.1,
      max_tokens: maxTokens,
    };
    if (supportsJsonSchema) {
      b.response_format = { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } };
    } else {
      b.response_format = { type: "json_object" };
    }
    return b;
  };

  // Try the primary model first (with response_format=json_schema). On any
  // failure, walk the fallback chain with a relaxed response_format.
  const fallbackChain = [model, ...getVisionFallbackChain().filter((m) => m !== model)];
  const errors: Array<{ model: string; err: string }> = [];

  for (let attempt = 0; attempt < fallbackChain.length; attempt++) {
    const m = fallbackChain[attempt];
    const tryJsonSchema = attempt === 0;
    const body = tryJsonSchema ? buildBody(m) : { ...buildBody(m), response_format: undefined };

    try {
      const content = await openrouterFetch(body);
      if (attempt > 0) {
        console.warn(`[multi-stage] ${schemaName} succeeded on fallback model ${m} after ${attempt} failures`);
      }
      return parseAndRepairJson(content, schemaName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ model: m, err: msg });
      // Continue to next model.
    }
  }

  throw new Error(
    `OpenRouter call failed for ${schemaName} after ${fallbackChain.length} attempts:\n` +
      errors.map((e, i) => `  [${i}] ${e.model}: ${e.err}`).join("\n"),
  );
}

function parseAndRepairJson(content: string, label: string): object {
  try { return JSON.parse(content.trim()); } catch {}

  let cleaned = content
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  try { return JSON.parse(cleaned); } catch {}

  cleaned = escapeControlCharsInJsonStrings(cleaned);

  try { return JSON.parse(cleaned); } catch {}

  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) {
    throw new Error(`[${label}] No JSON object found in: ${content.slice(0, 300)}`);
  }

  let depth = 0;
  let end = -1;
  for (let i = firstBrace; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{" && (i === 0 || cleaned[i - 1] !== "\\")) depth++;
    else if (ch === "}" && (i === 0 || cleaned[i - 1] !== "\\")) {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  if (end === -1) end = cleaned.length;

  let json = cleaned.slice(firstBrace, end).trim();

  if (!isBalanced(json)) {
    json = salvageTruncated(json);
  }

  try { return JSON.parse(json); } catch (e: any) {
    const repaired = json
      .replace(/,\s*}/g, "}")
      .replace(/,\s*\]/g, "]")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");

    try { return JSON.parse(repaired); } catch {}

    try {
      const salvaged = salvageTruncated(repaired);
      return JSON.parse(salvaged);
    } catch {}

    const preview = json.slice(0, 500);
    throw new Error(`[${label}] JSON parse error: ${e.message}. JSON excerpt: ${preview}...`);
  }
}

function escapeControlCharsInJsonStrings(json: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") {
        result += ch;
        if (i + 1 < json.length) result += json[++i];
      } else if (ch === '"') {
        inString = false;
        result += ch;
      } else if (ch === "\n") {
        result += "\\n";
      } else if (ch === "\r") {
        result += "\\r";
      } else if (ch === "\t") {
        result += "\\t";
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
  }
  return result;
}

function isBalanced(s: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "[" && (i === 0 || s[i - 1] !== "\\")) depth++;
    if (ch === "]" && (i === 0 || s[i - 1] !== "\\")) depth--;
  }
  return depth === 0 && !inString;
}

function salvageTruncated(json: string): string {
  let result = json;

  let inString = false;
  let stringStart = -1;
  for (let i = 0; i < result.length; i++) {
    if (result[i] === "\\") { i++; continue; }
    if (result[i] === '"') {
      if (inString) { inString = false; stringStart = -1; }
      else { inString = true; stringStart = i; }
    }
  }

  if (inString && stringStart >= 0) {
    const before = result.slice(0, stringStart);
    const afterColon = /:\s*$/.test(before);
    const afterCommaOrBrace = /[{,]\s*$/.test(before);

    if (afterCommaOrBrace || afterColon) {
      if (afterColon) {
        result = before.replace(/:\s*$/, "");
        result = result.replace(/,\s*$/, "");
      } else {
        const lastComma = before.lastIndexOf(",");
        if (lastComma >= 0) {
          result = before.slice(0, lastComma);
        } else {
          const openBrace = before.lastIndexOf("{");
          result = before.slice(0, openBrace + 1);
        }
      }
    } else {
      result += '"';
    }
  }

  result = result.replace(/,\s*$/, "");

  let objDepth = 0;
  let arrDepth = 0;
  inString = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (ch === "\\") { i++; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") objDepth++;
    if (ch === "}") objDepth--;
    if (ch === "[") arrDepth++;
    if (ch === "]") arrDepth--;
  }

  result += "]".repeat(Math.max(0, arrDepth));
  result += "}".repeat(Math.max(0, objDepth));

  return result;
}

// ── JSON Schemas ──

function imageContextSchema() { return { type: "object", additionalProperties: false, required: ["imageType","confidence","reason","needsOcr","needsLabelRecognition","canAssessVisualQuality","visibleClues"], properties: { imageType: { type: "string", enum: ["menu","tap_list","bottle","can","glass","venue","unknown"] }, confidence: { type: "number" }, reason: { type: "string" }, needsOcr: { type: "boolean" }, needsLabelRecognition: { type: "boolean" }, canAssessVisualQuality: { type: "boolean" }, visibleClues: { type: "array", items: { type: "string" } } } }; }

function beerSignalExtractSchema() { return { type: "object", additionalProperties: false, required: ["sourceType","rawText","items","visualBeerDescription","uncertainties"], properties: { sourceType: { type: "string", enum: ["menu","tap_list","bottle","can","glass","venue","text","unknown"] }, rawText: { type: "string" }, visualBeerDescription: { type: "object", additionalProperties: false, required: ["color","clarity","foam","visiblePackagingDate","notes"], properties: { color:{type:"string"}, clarity:{type:"string"}, foam:{type:"string"}, visiblePackagingDate:{type:"string"}, notes:{type:"array",items:{type:"string"}} } }, uncertainties: { type: "array", items: { type: "string" } }, items: { type: "array", items: { type: "object", additionalProperties: false, required: ["menuIndex","rawText","beerName","brewery","style","abv","ibu","price","serving","packagingDate","confidence"], properties: { menuIndex:{type:"integer"}, rawText:{type:"string"}, beerName:{type:"string"}, brewery:{type:"string"}, style:{type:"string"}, abv:{type:"number"}, ibu:{type:"number"}, price:{type:"number"}, serving:{type:"string"}, packagingDate:{type:"string"}, confidence:{type:"number"} } } } } }; }

function visualQualitySchema() { return { type: "object", additionalProperties: false, required: ["canAssess","visualRiskFlags","oxidationRisk","freshnessRisk","lightstrikeRisk","evidence","caveat"], properties: { canAssess:{type:"boolean"}, visualRiskFlags:{type:"array",items:{type:"string",enum:["possible_oxidation","possible_stale_hops","possible_lightstrike","low_foam","unexpected_haze","unexpected_darkening","date_not_visible","packaging_damage","low_confidence"]}}, oxidationRisk:{type:"string",enum:["low","medium","high","unknown"]}, freshnessRisk:{type:"string",enum:["low","medium","high","unknown"]}, lightstrikeRisk:{type:"string",enum:["low","medium","high","unknown"]}, evidence:{type:"array",items:{type:"string"}}, caveat:{type:"string"} } }; }

function recommendationSchema() { return { type: "object", additionalProperties: false, required: ["reply","topPickId","safePickId","explorePickId","avoidPickId","topReason","safeReason","exploreReason","avoidReason"], properties: { reply:{type:"string"}, topPickId:{type:"string"}, safePickId:{type:"string"}, explorePickId:{type:"string"}, avoidPickId:{type:"string"}, topReason:{type:"string"}, safeReason:{type:"string"}, exploreReason:{type:"string"}, avoidReason:{type:"string"} } }; }
