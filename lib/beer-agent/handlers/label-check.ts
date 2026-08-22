import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { openrouterFetch } from "@/lib/beer-agent/openrouter-client";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

type ModelConfig = { provider: string; model: string; temperature: number; maxTokens: number; timeoutMs: number };

async function loadConfig(): Promise<any> {
  try { const raw = await readFile(CONFIG_PATH, "utf8"); return JSON.parse(raw); }
  catch { return {}; }
}

async function getModelConfig(kind: string): Promise<ModelConfig> {
  const cfg = await loadConfig();
  const fromConfig = cfg.models?.[kind];
  const defaults: Record<string, ModelConfig> = {
    vision:   { provider: "openrouter", model: "qwen/qwen3-vl-32b-instruct", temperature: 0.1, maxTokens: 12000, timeoutMs: 120000 },
    analysis: { provider: "openrouter", model: "qwen/qwen-2.5-72b-instruct", temperature: 0.3, maxTokens: 1500,  timeoutMs: 20000 },
  };
  if (fromConfig && typeof fromConfig === "object" && fromConfig.model) return fromConfig as ModelConfig;
  if (typeof fromConfig === "string" && fromConfig) return { ...defaults[kind], model: fromConfig };
  return defaults[kind];
}

export async function handleLabelCheck(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
  const visionCfg = await getModelConfig("vision");
  const analysisCfg = await getModelConfig("analysis");
  // Image mode: use vision model for bottle/can label inspection
  if (request.image?.dataUrl) {
    try {
      const imageDataUrl = request.image.dataUrl;
      const userText = request.messages.at(-1)?.content ?? "";

      const prompt = `你是啤酒酒标检查器。分析这张酒瓶/酒罐的照片。

## 任务
1. 识别酒名(beerName)、酒厂(brewery)、风格(style)、ABV、容量(volumeMl)
2. 找到包装日期(packagingDate)或生产日期(productionDate)
3. 日期格式通常是 "YYYY-MM-DD" 或 "YYYY.MM.DD"
4. 检查酒标是否有可见问题：褪色、破损、液体渗出、变形
5. 判断新鲜度：如果是IPA/BPA，日期超过3个月就不太新鲜了

用户补充需求：${userText}

返回JSON:
{
  "reply": "中文总结",
  "beerName": "",
  "brewery": "",
  "style": "",
  "abv": 0,
  "volumeMl": 0,
  "packagingDate": "",
  "productionDate": "",
  "issues": [],
  "freshnessAssessment": "fresh|borderline|stale|unknown"
}`;

      const raw = await openrouterFetch({
        model: visionCfg.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        }],
        temperature: 0.1,
        max_tokens: 1000,
      });

      let parsed: any;
      try {
        const jsonStart = raw.indexOf("{");
        const jsonEnd = raw.lastIndexOf("}");
        parsed = jsonStart >= 0 && jsonEnd > jsonStart
          ? JSON.parse(raw.slice(jsonStart, jsonEnd + 1))
          : { reply: raw };
      } catch {
        parsed = { reply: raw };
      }

      const reply = parsed.reply || `已分析酒标：${parsed.beerName || "未识别酒名"}`;

      return {
        mode: "recommend",
        reply,
        candidates: [],
        picks: emptyPicks(),
        profileSummary: context.memorySnapshot?.profileSummary ?? "",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn("[label-check] vision analysis failed:", errMsg);
      if (!context.handlerErrors) context.handlerErrors = [];
      context.handlerErrors.push({ message: errMsg, model: visionCfg.model });
      return {
        mode: "recommend",
        reply: "抱歉，分析这张酒标时出错了。请拍一张清楚的酒标正面照再试试。",
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
      };
    }
  }

  // Text-only mode: general chat about a specific beer/bottle
  const lastUserText = request.messages.at(-1)?.content ?? "";
  try {
    const raw = await openrouterFetch({
      model: analysisCfg.model,
      messages: [
        {
          role: "system",
          content: "你是啤酒专家。用户想了解一款酒的酒标信息（日期、新鲜度等）。用中文简短回答，不要说太多无关内容。如果没有图片，请用户发一张酒标照片。",
        },
        { role: "user", content: lastUserText },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    return {
      mode: "recommend",
      reply: raw.trim(),
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  } catch (err) {
    return {
      mode: "recommend",
      reply: "请发一张酒标/酒瓶照片给我，我帮你检查日期和新鲜度。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }
}
