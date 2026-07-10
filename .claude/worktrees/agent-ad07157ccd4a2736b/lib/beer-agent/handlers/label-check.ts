import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { openrouterFetch } from "@/lib/beer-agent/openrouter-client";

const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash";
const ANALYSIS_MODEL = process.env.OPENROUTER_ANALYSIS_MODEL ?? "openai/gpt-4o-mini";

export async function handleLabelCheck(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
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
        model: VISION_MODEL,
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
      console.warn("[label-check] vision analysis failed:", err);
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
      model: ANALYSIS_MODEL,
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
