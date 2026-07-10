import { openrouterFetch } from "./openrouter-client";

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

// ── Main pipeline ──

export async function runMultiStagePipeline(params: {
  apiKey: string;
  imageDataUrl: string | null;
  userText: string;
  profile: string;
  onProgress?: ProgressCallback;
}): Promise<PipelineResult> {
  const { apiKey, imageDataUrl, userText, profile, onProgress } = params;
  const visionModel = process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash";
  const analysisModel = process.env.OPENROUTER_ANALYSIS_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

  const emit = onProgress ?? (() => {});

  // Stage 1: classify image (image only)
  const imageContext = imageDataUrl
    ? await withProgress(emit, "image_classification", "🔍 图片分类", visionModel,
        () => classifyImage(apiKey, visionModel, imageDataUrl, userText))
    : textOnlyImageContext();

  // Stage 2: extract beer signals (OCR)
  const extracted = imageDataUrl
    ? await withProgress(emit, "ocr", "📝 OCR 候选酒提取", visionModel,
        () => extractBeerSignal(apiKey, visionModel, imageDataUrl, imageContext!, userText))
    : await withProgress(emit, "ocr", "📝 文本实体抽取", analysisModel,
        () => extractBeerFromText(apiKey, analysisModel, userText));

  // Stage 3: visual quality (image only)
  const visualQuality = imageDataUrl
    ? await withProgress(emit, "visual_quality", "🔬 视觉质量检查", visionModel,
        () => assessVisualQuality(apiKey, visionModel, imageDataUrl, imageContext!, extracted, userText))
    : textOnlyVisualQuality();

  // Stage 4: recommendation
  const recommendation = await withProgress(emit, "recommendation", "🧠 智能推荐分析", analysisModel,
    () => analyzeRecommendation(apiKey, analysisModel, extracted, imageContext!, visualQuality!, profile, userText)
  );

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

// ── Stage 1: Image classification ──

async function classifyImage(
  apiKey: string, model: string, imageDataUrl: string, userText: string
): Promise<ImageContext> {
  const schema = imageContextSchema();
  const result = await callOpenRouterJson(apiKey, model, [
    { role: "user", content: [
      { type: "text", text: `你是啤酒图片路由器。先判断这张图是什么类型。

图片类型只能选：
- menu: 普通酒单、纸质/屏幕菜单
- tap_list: 酒吧 tap list、酒头列表、黑板生啤列表
- bottle: 单个瓶子/瓶标
- can: 单个罐子/罐标
- glass: 杯中酒液
- venue: 酒吧环境/冰柜/货架
- unknown: 无法判断

还要判断是否需要 OCR、是否需要酒标识别、是否能做视觉质量风险观察。

用户补充需求：${userText}` },
      { type: "image_url", image_url: { url: imageDataUrl } }
    ]}
  ], schema, "beer_image_context", 600);
  return result as ImageContext;
}

// ── Stage 2: Beer signal extraction ──

async function extractBeerSignal(
  apiKey: string, model: string, imageDataUrl: string,
  imageContext: ImageContext, userText: string
): Promise<BeerSignal> {
  const schema = beerSignalExtractSchema();
  const result = await callOpenRouterJson(apiKey, model, [
    { role: "user", content: [
      { type: "text", text: `你是啤酒 OCR / 酒标识别 / 候选酒抽取器。

上游图片分类：
${JSON.stringify(imageContext, null, 2)}

任务：
1. 如果是 menu/tap_list，从图中识别所有啤酒候选项。
2. 如果是 bottle/can，从酒标中识别单个酒款，尽量抽取酒名、酒厂、风格、ABV。
3. 如果是 glass，只描述可见酒液，不要编造酒名；items 可以为空或低置信度。
4. 保留原文（OCR 原文，一行一款酒）。
5. 尽量抽取酒名、酒厂、风格、ABV、IBU、价格（元）、容量（ml）。
6. 不确定就把 confidence 降低，不要编造酒名。
7. price 字段只填数字（元），serving 字段填容量信息如"330ml"、"一品脱"等。

用户补充需求：${userText}` },
      { type: "image_url", image_url: { url: imageDataUrl } }
    ]}
  ], schema, "beer_signal_extract", 4000);
  return result as BeerSignal;
}

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

// ── Stage 3: Visual quality ──

async function assessVisualQuality(
  apiKey: string, model: string, imageDataUrl: string,
  imageContext: ImageContext, extracted: BeerSignal, userText: string
): Promise<VisualQuality> {
  const schema = visualQualitySchema();
  const result = await callOpenRouterJson(apiKey, model, [
    { role: "user", content: [
      { type: "text", text: `你是啤酒视觉质量观察器。请只基于图片可见信息判断风险，不要做绝对结论。

重点看：
- 如果是杯中酒：颜色是否异常发暗/棕化、泡沫是否快速消散、浑浊是否符合风格、是否像氧化/老化/受光照影响。
- 如果是瓶/罐：是否能看到日期、是否过期、瓶型是否透明/绿瓶导致光照风险、包装是否受损。
- 如果是酒单/tap list：能否看到日期、是否有 IPA 新鲜度风险。

上游图片分类：
${JSON.stringify(imageContext, null, 2)}

候选酒抽取：
${JSON.stringify(extracted, null, 2)}

用户补充需求：${userText}

注意：氧化只能说"视觉风险/疑似"，不能说一定氧化。` },
      { type: "image_url", image_url: { url: imageDataUrl } }
    ]}
  ], schema, "beer_visual_quality", 900);
  return result as VisualQuality;
}

// ── Stage 4: Recommendation ──

async function analyzeRecommendation(
  apiKey: string, model: string,
  extracted: BeerSignal, imageContext: ImageContext,
  visualQuality: VisualQuality, profile: string, userText: string
): Promise<PipelineRecommendation> {
  // Build a flat list of beer names from OCR for the LLM to reference
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

  // Build request body — skip response_format for models that don't support it well
  const supportsJsonSchema = !model.includes("gemini");

  const body: any = {
    model,
    messages: messages.map((m: any) => {
      if (typeof m.content === "string") {
        return {
          ...m,
          content: `${m.content}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}`,
        };
      }
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((part: any) =>
            part.type === "text"
              ? { ...part, text: `${part.text}\n\nYou MUST return ONLY a single JSON object. No markdown, no code fences. Follow this JSON schema exactly:\n${schemaJson}` }
              : part
          ),
        };
      }
      return m;
    }),
    temperature: 0.1,
    max_tokens: maxTokens,
  };

  if (supportsJsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    };
  } else {
    body.response_format = { type: "json_object" };
  }

  let content: string;
  try {
    content = await openrouterFetch(body);
  } catch (err) {
    // Fallback: strip response_format entirely, rely on prompt
    const fallbackBody = {
      ...body,
      response_format: undefined,
    };
    try {
      content = await openrouterFetch(fallbackBody);
    } catch (err2) {
      throw new Error(`OpenRouter call failed for ${schemaName}: ${err instanceof Error ? err.message : String(err)}; fallback: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }

  // Parse JSON with repair
  return parseAndRepairJson(content, schemaName);
}

function parseAndRepairJson(content: string, label: string): object {
  // Try direct parse first
  try {
    return JSON.parse(content.trim());
  } catch {}

  // Strip markdown fences
  let cleaned = content
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  // Try again
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Extract first { ... } pair
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) {
    throw new Error(`[${label}] No JSON object found in: ${content.slice(0, 300)}`);
  }

  // Find matching closing brace
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

  if (end === -1) {
    // Truncated JSON — try to salvage by closing open structures
    end = cleaned.length;
  }

  let json = cleaned.slice(firstBrace, end).trim();

  // If still unbalanced, try to close any open strings/objects/arrays
  if (!isBalanced(json)) {
    json = salvageTruncated(json);
  }

  // Try parsing
  try {
    return JSON.parse(json);
  } catch (e: any) {
    // Try common repairs
    const repaired = json
      .replace(/,\s*}/g, "}")
      .replace(/,\s*\]/g, "]")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");

    try {
      return JSON.parse(repaired);
    } catch {}

    const preview = json.slice(0, 500);
    throw new Error(`[${label}] JSON parse error: ${e.message}. JSON excerpt: ${preview}...`);
  }
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
  // Close any open string, then close open arrays/objects
  let result = json;

  // If we're in the middle of a string, close it
  let inString = false;
  for (let i = 0; i < result.length; i++) {
    if (result[i] === "\\") { i++; continue; }
    if (result[i] === '"') inString = !inString;
  }
  if (inString) result += '"';

  // Count and close open brackets
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

  // If we were in the middle of an array element, remove trailing comma first
  result = result.replace(/,\s*$/, "");

  // Close open arrays, then objects
  result += "]".repeat(Math.max(0, arrDepth));
  result += "}".repeat(Math.max(0, objDepth));

  return result;
}

// ── JSON Schemas ──

function imageContextSchema() { return { type: "object", additionalProperties: false, required: ["imageType","confidence","reason","needsOcr","needsLabelRecognition","canAssessVisualQuality","visibleClues"], properties: { imageType: { type: "string", enum: ["menu","tap_list","bottle","can","glass","venue","unknown"] }, confidence: { type: "number" }, reason: { type: "string" }, needsOcr: { type: "boolean" }, needsLabelRecognition: { type: "boolean" }, canAssessVisualQuality: { type: "boolean" }, visibleClues: { type: "array", items: { type: "string" } } } }; }

function beerSignalExtractSchema() { return { type: "object", additionalProperties: false, required: ["sourceType","rawText","items","visualBeerDescription","uncertainties"], properties: { sourceType: { type: "string", enum: ["menu","tap_list","bottle","can","glass","venue","text","unknown"] }, rawText: { type: "string" }, visualBeerDescription: { type: "object", additionalProperties: false, required: ["color","clarity","foam","visiblePackagingDate","notes"], properties: { color:{type:"string"}, clarity:{type:"string"}, foam:{type:"string"}, visiblePackagingDate:{type:"string"}, notes:{type:"array",items:{type:"string"}} } }, uncertainties: { type: "array", items: { type: "string" } }, items: { type: "array", items: { type: "object", additionalProperties: false, required: ["menuIndex","rawText","beerName","brewery","style","abv","ibu","price","serving","packagingDate","confidence"], properties: { menuIndex:{type:"integer"}, rawText:{type:"string"}, beerName:{type:"string"}, brewery:{type:"string"}, style:{type:"string"}, abv:{type:"number"}, ibu:{type:"number"}, price:{type:"number"}, serving:{type:"string"}, packagingDate:{type:"string"}, confidence:{type:"number"} } } } } }; }

function visualQualitySchema() { return { type: "object", additionalProperties: false, required: ["canAssess","visualRiskFlags","oxidationRisk","freshnessRisk","lightstrikeRisk","evidence","caveat"], properties: { canAssess:{type:"boolean"}, visualRiskFlags:{type:"array",items:{type:"string",enum:["possible_oxidation","possible_stale_hops","possible_lightstrike","low_foam","unexpected_haze","unexpected_darkening","date_not_visible","packaging_damage","low_confidence"]}}, oxidationRisk:{type:"string",enum:["low","medium","high","unknown"]}, freshnessRisk:{type:"string",enum:["low","medium","high","unknown"]}, lightstrikeRisk:{type:"string",enum:["low","medium","high","unknown"]}, evidence:{type:"array",items:{type:"string"}}, caveat:{type:"string"} } }; }

function recommendationSchema() { return { type: "object", additionalProperties: false, required: ["reply","topPickId","safePickId","explorePickId","avoidPickId","topReason","safeReason","exploreReason","avoidReason"], properties: { reply:{type:"string"}, topPickId:{type:"string"}, safePickId:{type:"string"}, explorePickId:{type:"string"}, avoidPickId:{type:"string"}, topReason:{type:"string"}, safeReason:{type:"string"}, exploreReason:{type:"string"}, avoidReason:{type:"string"} } }; }
