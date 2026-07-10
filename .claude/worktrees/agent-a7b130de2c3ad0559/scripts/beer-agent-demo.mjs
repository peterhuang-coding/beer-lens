#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const execFileAsync = promisify(execFile);
loadEnv(path.join(root, ".env.local"));
loadEnv(path.join(root, ".env"));

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.feedback) {
  const entry = parseFeedback(String(args.feedback));
  await appendJournalEntry(entry);
  console.log(JSON.stringify({ ok: true, saved: entry }, null, 2));
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  fail(`Missing OPENROUTER_API_KEY.

Create .env.local from .env.local.template and put your key there:

cp .env.local.template .env.local
`);
}

if (!args.image && !args.text) {
  fail("Pass --image path/to/menu.jpg, --text \"需求\", or --feedback \"4.2，会再喝...\".");
}

const profile = await readProfile();
const imageDataUrl = args.image ? await readImageAsDataUrl(String(args.image)) : null;
const userText = String(args.text ?? "帮我看这张酒单，按我的喜好推荐。");

const imageContext = imageDataUrl
  ? await classifyImage({
      apiKey,
      imageDataUrl,
      userText
    })
  : textOnlyImageContext();

const extracted = await extractBeerSignal({
  apiKey,
  imageDataUrl,
  imageContext,
  userText
});

const visualQuality = imageDataUrl
  ? await assessVisualQuality({
      apiKey,
      imageDataUrl,
      imageContext,
      extracted,
      userText
    })
  : textOnlyVisualQuality();

const recommendation = await analyzeRecommendation({
  apiKey,
  extracted,
  imageContext,
  visualQuality,
  profile,
  userText
});

const run = {
  createdAt: new Date().toISOString(),
  input: {
    image: args.image ? String(args.image) : null,
    text: userText
  },
  profile,
  imageContext,
  extracted,
  visualQuality,
  recommendation
};

await mkdir(path.join(root, "data", "runs"), { recursive: true });
const outPath =
  args.out ??
  path.join(root, "data", "runs", `beer-agent-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(String(outPath), `${JSON.stringify(run, null, 2)}\n`);

console.log("\n=== Beer Agent Recommendation ===\n");
console.log(recommendation.reply);
console.log("\n=== Image Context ===\n");
console.log(
  `${imageContext.imageType} | confidence ${imageContext.confidence} | ${imageContext.reason}`
);
if (visualQuality.visualRiskFlags?.length) {
  console.log(`Visual risks: ${visualQuality.visualRiskFlags.join(", ")}`);
}

console.log("\n=== Top Candidates ===\n");
for (const candidate of recommendation.candidates ?? []) {
  console.log(
    `${candidate.menuIndex ? `${candidate.menuIndex}. ` : ""}${candidate.displayName} | Worth ${
      candidate.worthScore
    } | Fit ${candidate.fitScore}`
  );
  console.log(`   ${candidate.reason}`);
}
console.log(`\nSaved run: ${outPath}\n`);

async function classifyImage({ apiKey, imageDataUrl, userText }) {
  return callOpenRouterJson({
    apiKey,
    model: process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `你是啤酒图片路由器。先判断这张图是什么类型，然后决定后续链路。

图片类型只能选：
- menu: 普通酒单、纸质/屏幕菜单
- tap_list: 酒吧 tap list、酒头列表、黑板生啤列表
- bottle: 单个瓶子/瓶标
- can: 单个罐子/罐标
- glass: 杯中酒液
- venue: 酒吧环境/冰柜/货架
- unknown: 无法判断

还要判断是否需要 OCR、是否需要酒标识别、是否能做视觉质量风险观察。

用户补充需求：${userText}`
          },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl
            }
          }
        ]
      }
    ],
    schemaName: "beer_image_context",
    schema: imageContextSchema(),
    maxTokens: 900
  });
}

async function extractBeerSignal({ apiKey, imageDataUrl, imageContext, userText }) {
  const content = imageDataUrl
    ? [
        {
          type: "text",
          text: `你是啤酒 OCR / 酒标识别 / 候选酒抽取器。

上游图片分类：
${JSON.stringify(imageContext, null, 2)}

任务：
1. 如果是 menu/tap_list，从图中识别所有啤酒候选项。
2. 如果是 bottle/can，从酒标中识别单个酒款，尽量抽取酒名、酒厂、风格、ABV。
3. 如果是 glass，只描述可见酒液，不要编造酒名；items 可以为空或低置信度。
4. 保留原文。
5. 尽量抽取酒名、酒厂、风格、ABV、IBU、价格、容量。
6. 不确定就把 confidence 降低，不要编造。

用户补充需求：${userText}`
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl
          }
        }
      ]
    : `你是酒单 OCR 和啤酒实体抽取器。请从以下文字中抽取啤酒候选项，不确定不要编造：\n${userText}`;

  return callOpenRouterJson({
    apiKey,
    model: process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash",
    messages: [{ role: "user", content }],
    schemaName: "beer_signal_extract",
    schema: beerSignalExtractSchema(),
    maxTokens: 2200
  });
}

async function assessVisualQuality({ apiKey, imageDataUrl, imageContext, extracted, userText }) {
  return callOpenRouterJson({
    apiKey,
    model: process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `你是啤酒视觉质量观察器。请只基于图片可见信息判断风险，不要做绝对结论。

重点看：
- 如果是杯中酒：颜色是否异常发暗/棕化、泡沫是否快速消散、浑浊是否符合风格、是否像氧化/老化/受光照影响。
- 如果是瓶/罐：是否能看到日期、是否过期、瓶型是否透明/绿瓶导致光照风险、包装是否受损。
- 如果是酒单/tap list：能否看到日期、是否有 IPA 新鲜度风险。

上游图片分类：
${JSON.stringify(imageContext, null, 2)}

候选酒抽取：
${JSON.stringify(extracted, null, 2)}

用户补充需求：${userText}

注意：氧化只能说“视觉风险/疑似”，不能说一定氧化。`
          },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl
            }
          }
        ]
      }
    ],
    schemaName: "beer_visual_quality",
    schema: visualQualitySchema(),
    maxTokens: 1200
  });
}

async function analyzeRecommendation({ apiKey, extracted, imageContext, visualQuality, profile, userText }) {
  return callOpenRouterJson({
    apiKey,
    model: process.env.OPENROUTER_ANALYSIS_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `你是 Beer Lens，一个懂啤酒、懂个人口味的推荐 agent。

必须用中文回答。
你要区分：
- worthScore: 这款酒客观/场景上值不值得喝
- fitScore: 这款酒适不适合这个用户

不要迷信公共评分。用户明确说想清爽、不苦、尝新、配餐时，优先匹配意图。
如果信息来自 OCR 且不确定，要在 reason 或 riskFlags 里说明。
如果视觉质量观察有氧化、老化、新鲜度、包装受光照等风险，要影响 worthScore，但不要把疑似风险说成事实。

用户画像：
${profile}`
      },
      {
        role: "user",
        content: `用户这次的需求：
${userText}

OCR/候选酒抽取结果：
${JSON.stringify(extracted, null, 2)}

图片上下文：
${JSON.stringify(imageContext, null, 2)}

视觉质量风险：
${JSON.stringify(visualQuality, null, 2)}

请输出 top picks、候选酒分数和一句人话推荐。`
      }
    ],
    schemaName: "beer_recommendation",
    schema: recommendationSchema(),
    maxTokens: 2600
  });
}

async function callOpenRouterJson({ apiKey, model, messages, schemaName, schema, maxTokens }) {
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema
      }
    },
    plugins: [{ id: "response-healing" }]
  };

  const strictResult = await callOpenRouter(apiKey, body).catch(async (error) => {
    const looseBody = {
      ...body,
      response_format: { type: "json_object" },
      messages: [
        ...messages,
        {
          role: "user",
          content: `If strict schema failed, return valid JSON matching this schema as closely as possible:\n${JSON.stringify(
            schema
          )}`
        }
      ]
    };
    const loose = await callOpenRouter(apiKey, looseBody).catch(() => {
      throw error;
    });
    return loose;
  });

  return parseJsonContent(strictResult);
}

async function callOpenRouter(apiKey, body) {
  const requestBody = JSON.stringify(body);
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Beer Lens"
  };

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: requestBody
    });

    if (!response.ok) {
      throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const content = result?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenRouter returned empty content");
    }
    return content;
  } catch (error) {
    if (!shouldFallbackToCurl(error)) {
      throw error;
    }

    return callOpenRouterWithCurl({ headers, requestBody });
  }
}

async function callOpenRouterWithCurl({ headers, requestBody }) {
  const curlArgs = [
    "-sS",
    "--fail-with-body",
    "--connect-timeout",
    String(process.env.OPENROUTER_CONNECT_TIMEOUT ?? 30),
    "--max-time",
    String(process.env.OPENROUTER_MAX_TIME ?? 120),
    "https://openrouter.ai/api/v1/chat/completions",
    "-H",
    `authorization: ${headers.authorization}`,
    "-H",
    `content-type: ${headers["content-type"]}`,
    "-H",
    `HTTP-Referer: ${headers["HTTP-Referer"]}`,
    "-H",
    `X-Title: ${headers["X-Title"]}`,
    "-d",
    requestBody
  ];

  const proxy =
    process.env.OPENROUTER_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;

  if (proxy) {
    curlArgs.unshift("--proxy", proxy);
  }

  try {
    const { stdout } = await execFileAsync("curl", curlArgs, {
      maxBuffer: 10 * 1024 * 1024
    });
    const result = JSON.parse(stdout);
    const content = result?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`OpenRouter curl returned empty content: ${stdout.slice(0, 300)}`);
    }
    return content;
  } catch (error) {
    const hint = proxy
      ? `Proxy in use: ${proxy}`
      : "No proxy detected. If you use Clash/V2Ray/Surge, set OPENROUTER_PROXY=http://127.0.0.1:7890 in .env.local.";
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenRouter request failed through fetch and curl. ${hint}\n${detail}`);
  }
}

function shouldFallbackToCurl(error) {
  const message = error instanceof Error ? `${error.message} ${error.cause?.code ?? ""}` : String(error);
  return /fetch failed|timeout|UND_ERR|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(message);
}

function parseJsonContent(content) {
  if (typeof content !== "string") {
    return content;
  }

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Could not parse JSON from model response: ${content.slice(0, 300)}`);
    return JSON.parse(match[0]);
  }
}

async function readImageAsDataUrl(filePath) {
  const absolutePath = path.resolve(root, filePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  const buffer = await readFile(absolutePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function readProfile() {
  const profilePath = path.join(root, "data", "beer_profile.md");
  if (!existsSync(profilePath)) return "还没有正式记录。";
  return readFile(profilePath, "utf8");
}

async function appendJournalEntry(entry) {
  const journalPath = path.join(root, "data", "beer_journal.json");
  const journal = existsSync(journalPath)
    ? JSON.parse(await readFile(journalPath, "utf8"))
    : { version: 1, entries: [] };

  journal.entries.unshift(entry);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

function parseFeedback(rawInput) {
  const scoreMatch = rawInput.match(/([1-5](?:\.\d)?)(?:\s*分)?/);
  const wouldDrinkAgain = rawInput.includes("不会")
    ? "no"
    : rawInput.includes("看情况") || rawInput.includes("一般")
      ? "maybe"
      : rawInput.includes("再喝") || rawInput.includes("会")
        ? "yes"
        : undefined;

  return {
    id: `entry_${Date.now()}`,
    createdAt: new Date().toISOString(),
    rawInput,
    parsed: {
      beerName: rawInput.match(/(?:喝了|记录|酒[:：]?)([^，,。]+)/)?.[1]?.trim(),
      overallScore: scoreMatch ? Number(scoreMatch[1]) : undefined,
      wouldDrinkAgain,
      aromaTags: collectTags(rawInput, {
        柑橘: "citrus",
        热带水果: "tropical",
        松针: "pine",
        花香: "floral",
        咖啡: "coffee",
        焦糖: "caramel",
        酸: "sour_funk",
        野菌: "sour_funk",
        酒精: "alcohol"
      }),
      tasteTags: collectTags(rawInput, {
        清爽: "crisp",
        顺滑: "smooth",
        多汁: "juicy",
        甜: "sweet",
        苦: "bitter",
        厚: "heavy_body",
        干: "dry_finish",
        平衡: "balanced"
      }),
      contextTags: collectTags(rawInput, {
        第一杯: "first_beer",
        配餐: "with_food",
        尝新: "explore",
        聚会: "social",
        收尾: "dessert"
      }),
      note: rawInput
    }
  };
}

function collectTags(rawInput, map) {
  return Object.entries(map)
    .filter(([keyword]) => rawInput.includes(keyword))
    .map(([, tag]) => tag)
    .filter((tag, index, tags) => tags.indexOf(tag) === index);
}

function imageContextSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "imageType",
      "confidence",
      "reason",
      "needsOcr",
      "needsLabelRecognition",
      "canAssessVisualQuality",
      "visibleClues"
    ],
    properties: {
      imageType: {
        type: "string",
        enum: ["menu", "tap_list", "bottle", "can", "glass", "venue", "unknown"]
      },
      confidence: { type: "number" },
      reason: { type: "string" },
      needsOcr: { type: "boolean" },
      needsLabelRecognition: { type: "boolean" },
      canAssessVisualQuality: { type: "boolean" },
      visibleClues: { type: "array", items: { type: "string" } }
    }
  };
}

function beerSignalExtractSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sourceType", "rawText", "items", "visualBeerDescription", "uncertainties"],
    properties: {
      sourceType: {
        type: "string",
        enum: ["menu", "tap_list", "bottle", "can", "glass", "venue", "text", "unknown"]
      },
      rawText: { type: "string" },
      visualBeerDescription: {
        type: "object",
        additionalProperties: false,
        required: ["color", "clarity", "foam", "visiblePackagingDate", "notes"],
        properties: {
          color: { type: "string" },
          clarity: { type: "string" },
          foam: { type: "string" },
          visiblePackagingDate: { type: "string" },
          notes: { type: "array", items: { type: "string" } }
        }
      },
      uncertainties: { type: "array", items: { type: "string" } },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "menuIndex",
            "rawText",
            "beerName",
            "brewery",
            "style",
            "abv",
            "ibu",
            "price",
            "serving",
            "packagingDate",
            "confidence"
          ],
          properties: {
            menuIndex: { type: "integer" },
            rawText: { type: "string" },
            beerName: { type: "string" },
            brewery: { type: "string" },
            style: { type: "string" },
            abv: { type: "number" },
            ibu: { type: "number" },
            price: { type: "number" },
            serving: { type: "string" },
            packagingDate: { type: "string" },
            confidence: { type: "number" }
          }
        }
      }
    }
  };
}

function visualQualitySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "canAssess",
      "visualRiskFlags",
      "oxidationRisk",
      "freshnessRisk",
      "lightstrikeRisk",
      "evidence",
      "caveat"
    ],
    properties: {
      canAssess: { type: "boolean" },
      visualRiskFlags: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "possible_oxidation",
            "possible_stale_hops",
            "possible_lightstrike",
            "low_foam",
            "unexpected_haze",
            "unexpected_darkening",
            "date_not_visible",
            "packaging_damage",
            "low_confidence"
          ]
        }
      },
      oxidationRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      freshnessRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      lightstrikeRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      evidence: { type: "array", items: { type: "string" } },
      caveat: { type: "string" }
    }
  };
}

function recommendationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "candidates", "topPickId", "safePickId", "explorePickId", "avoidPickId"],
    properties: {
      reply: { type: "string" },
      topPickId: { type: "string" },
      safePickId: { type: "string" },
      explorePickId: { type: "string" },
      avoidPickId: { type: "string" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "candidateId",
            "menuIndex",
            "displayName",
            "brewery",
            "style",
            "abv",
            "hops",
            "worthScore",
            "fitScore",
            "riskFlags",
            "reason"
          ],
          properties: {
            candidateId: { type: "string" },
            menuIndex: { type: "integer" },
            displayName: { type: "string" },
            brewery: { type: "string" },
            style: { type: "string" },
            abv: { type: "number" },
            hops: { type: "array", items: { type: "string" } },
            worthScore: { type: "integer" },
            fitScore: { type: "integer" },
            riskFlags: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      }
    }
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--image") parsed.image = argv[++index];
    else if (arg === "--text") parsed.text = argv[++index];
    else if (arg === "--feedback") parsed.feedback = argv[++index];
    else if (arg === "--out") parsed.out = argv[++index];
    else fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function printHelp() {
  console.log(`Beer Agent local demo

Usage:
  node scripts/beer-agent-demo.mjs --image ./menu.jpg --text "今天想喝清爽一点，不要太苦"
  node scripts/beer-agent-demo.mjs --text "酒单：Other Half Green City, Firestone Pivo Pils..."
  node scripts/beer-agent-demo.mjs --feedback "我喝了 Green City，4.5 分，会再喝，热带水果，顺滑"

Environment:
  OPENROUTER_API_KEY
  OPENROUTER_VISION_MODEL=google/gemini-2.5-flash
  OPENROUTER_ANALYSIS_MODEL=openai/gpt-4o-mini
  OPENROUTER_PROXY=http://127.0.0.1:7890
`);
}

function textOnlyImageContext() {
  return {
    imageType: "unknown",
    confidence: 0,
    reason: "No image provided; using text-only extraction.",
    needsOcr: false,
    needsLabelRecognition: false,
    canAssessVisualQuality: false,
    visibleClues: []
  };
}

function textOnlyVisualQuality() {
  return {
    canAssess: false,
    visualRiskFlags: ["low_confidence"],
    oxidationRisk: "unknown",
    freshnessRisk: "unknown",
    lightstrikeRisk: "unknown",
    evidence: [],
    caveat: "No image provided; visual freshness or oxidation cannot be assessed."
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
