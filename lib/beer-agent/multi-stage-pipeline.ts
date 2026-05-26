import type { BeerCandidate } from "./types";
import { openrouterFetch } from "./openrouter-client";

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
  candidates: BeerCandidate[];
  topPickId: string;
  safePickId: string;
  explorePickId: string;
  avoidPickId: string;
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
}): Promise<PipelineResult> {
  const { apiKey, imageDataUrl, userText, profile } = params;
  const visionModel = process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash";
  const analysisModel = process.env.OPENROUTER_ANALYSIS_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

  // Stage 1: classify image (image only)
  const imageContext = imageDataUrl
    ? await classifyImage(apiKey, visionModel, imageDataUrl, userText)
    : textOnlyImageContext();

  // Stage 2: extract beer signals (OCR)
  const extracted = imageDataUrl
    ? await extractBeerSignal(apiKey, visionModel, imageDataUrl, imageContext!, userText)
    : await extractBeerFromText(apiKey, analysisModel, userText);

  // Stage 3: visual quality (image only)
  const visualQuality = imageDataUrl
    ? await assessVisualQuality(apiKey, visionModel, imageDataUrl, imageContext!, extracted, userText)
    : textOnlyVisualQuality();

  // Stage 4: recommendation
  const recommendation = await analyzeRecommendation(
    apiKey, analysisModel, extracted, imageContext!, visualQuality!, profile, userText
  );

  return { imageContext, extracted, visualQuality, recommendation };
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
  ], schema, "beer_signal_extract", 2200);
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
  const schema = recommendationSchema();
  const result = await callOpenRouterJson(apiKey, model, [
    { role: "system", content: `你是 Beer Lens，一个懂啤酒、懂个人口味的推荐 agent。

必须用中文回答。
你要区分：
- worthScore: 这款酒客观/场景上值不值得喝 (0-100)
- fitScore: 这款酒适不适合这个用户 (0-100)

不要迷信公共评分。用户明确说想清爽、不苦、尝新、配餐时，优先匹配意图。
如果信息来自 OCR 且不确定，要在 reason 或 riskFlags 里说明。
如果视觉质量观察有氧化、老化、新鲜度、包装受光照等风险，要影响 worthScore，但不要把疑似风险说成事实。

用户画像：
${profile}` },
    { role: "user", content: `用户这次的需求：
${userText}

OCR/候选酒抽取结果：
${JSON.stringify(extracted, null, 2)}

图片上下文：
${JSON.stringify(imageContext, null, 2)}

视觉质量风险：
${JSON.stringify(visualQuality, null, 2)}

请输出 top picks、候选酒分数和一句人话推荐。` }
  ], schema, "beer_recommendation", 2600);
  return result as PipelineRecommendation;
}

// ── OpenRouter JSON call ──

async function callOpenRouterJson(
  apiKey: string, model: string,
  messages: object[], schema: object, schemaName: string, maxTokens: number
): Promise<object> {
  const body: any = {
    model,
    messages,
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
  };

  // Try strict schema first, fall back to json_object
  let content: string;
  try {
    content = await openrouterFetch(body);
  } catch {
    const looseBody = {
      ...body,
      response_format: { type: "json_object" },
      messages: [
        ...messages,
        { role: "user", content: `Return valid JSON matching this schema:\n${JSON.stringify(schema)}` }
      ],
    };
    content = await openrouterFetch(looseBody);
  }

  // Parse JSON from response
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Could not parse JSON from: ${content.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

// ── JSON Schemas ──

function imageContextSchema() { return { type: "object", additionalProperties: false, required: ["imageType","confidence","reason","needsOcr","needsLabelRecognition","canAssessVisualQuality","visibleClues"], properties: { imageType: { type: "string", enum: ["menu","tap_list","bottle","can","glass","venue","unknown"] }, confidence: { type: "number" }, reason: { type: "string" }, needsOcr: { type: "boolean" }, needsLabelRecognition: { type: "boolean" }, canAssessVisualQuality: { type: "boolean" }, visibleClues: { type: "array", items: { type: "string" } } } }; }

function beerSignalExtractSchema() { return { type: "object", additionalProperties: false, required: ["sourceType","rawText","items","visualBeerDescription","uncertainties"], properties: { sourceType: { type: "string", enum: ["menu","tap_list","bottle","can","glass","venue","text","unknown"] }, rawText: { type: "string" }, visualBeerDescription: { type: "object", additionalProperties: false, required: ["color","clarity","foam","visiblePackagingDate","notes"], properties: { color:{type:"string"}, clarity:{type:"string"}, foam:{type:"string"}, visiblePackagingDate:{type:"string"}, notes:{type:"array",items:{type:"string"}} } }, uncertainties: { type: "array", items: { type: "string" } }, items: { type: "array", items: { type: "object", additionalProperties: false, required: ["menuIndex","rawText","beerName","brewery","style","abv","ibu","price","serving","packagingDate","confidence"], properties: { menuIndex:{type:"integer"}, rawText:{type:"string"}, beerName:{type:"string"}, brewery:{type:"string"}, style:{type:"string"}, abv:{type:"number"}, ibu:{type:"number"}, price:{type:"number"}, serving:{type:"string"}, packagingDate:{type:"string"}, confidence:{type:"number"} } } } } }; }

function visualQualitySchema() { return { type: "object", additionalProperties: false, required: ["canAssess","visualRiskFlags","oxidationRisk","freshnessRisk","lightstrikeRisk","evidence","caveat"], properties: { canAssess:{type:"boolean"}, visualRiskFlags:{type:"array",items:{type:"string",enum:["possible_oxidation","possible_stale_hops","possible_lightstrike","low_foam","unexpected_haze","unexpected_darkening","date_not_visible","packaging_damage","low_confidence"]}}, oxidationRisk:{type:"string",enum:["low","medium","high","unknown"]}, freshnessRisk:{type:"string",enum:["low","medium","high","unknown"]}, lightstrikeRisk:{type:"string",enum:["low","medium","high","unknown"]}, evidence:{type:"array",items:{type:"string"}}, caveat:{type:"string"} } }; }

function recommendationSchema() { return { type: "object", additionalProperties: false, required: ["reply","candidates","topPickId","safePickId","explorePickId","avoidPickId"], properties: { reply:{type:"string"}, topPickId:{type:"string"}, safePickId:{type:"string"}, explorePickId:{type:"string"}, avoidPickId:{type:"string"}, candidates:{type:"array",items:{type:"object",additionalProperties:false,required:["candidateId","menuIndex","displayName","brewery","style","abv","hops","worthScore","fitScore","riskFlags","reason"],properties:{candidateId:{type:"string"},menuIndex:{type:"integer"},displayName:{type:"string"},brewery:{type:"string"},style:{type:"string"},abv:{type:"number"},hops:{type:"array",items:{type:"string"}},worthScore:{type:"integer"},fitScore:{type:"integer"},riskFlags:{type:"array",items:{type:"string"}},reason:{type:"string"}}}} } }; }
