import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

async function getVisionModel(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const raw = await readFile(path.join(process.cwd(), "data", "pipeline-config.json"), "utf8");
    const cfg = JSON.parse(raw);
    const mc = cfg.models?.vision;
    if (typeof mc === "object" && mc.model) return mc.model;
    if (typeof mc === "string") return mc;
  } catch {}
  return process.env.OPENROUTER_VISION_MODEL ?? "qwen/qwen3-vl-32b-instruct";
}

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  // Image mode: use vision model
  if (ctx.imageDataUrl) {
    try {
      const { openrouterFetch } = await import("@/lib/beer-agent/openrouter-client");
      const visionModel = await getVisionModel();
      const userText = ctx.lastUserText;

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
        model: visionModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: ctx.imageDataUrl } },
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

      return {
        skillId: "label-check",
        reply: parsed.reply || `已分析酒标：${parsed.beerName || "未识别酒名"}`,
        candidates: [],
        picks: emptyPicks(),
        profileSummary: ctx.profileSummary ?? "",
        errors: [],
      };
    } catch (err) {
      return {
        skillId: "label-check",
        reply: "抱歉，分析这张酒标时出错了。请拍一张清楚的酒标正面照再试试。",
        candidates: [],
        picks: emptyPicks(),
        profileSummary: "",
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  // Text-only: ask for photo
  try {
    const { openrouterFetch } = await import("@/lib/beer-agent/openrouter-client");
    const raw = await openrouterFetch({
      model: process.env.OPENROUTER_MODEL ?? "qwen/qwen-2.5-72b-instruct",
      messages: [
        { role: "system", content: "你是啤酒专家。用户想了解一款酒的酒标信息（日期、新鲜度等）。用中文简短回答，不要说太多无关内容。如果没有图片，请用户发一张酒标照片。" },
        { role: "user", content: ctx.lastUserText },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    return {
      skillId: "label-check",
      reply: raw.trim(),
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [],
    };
  } catch {
    return {
      skillId: "label-check",
      reply: "请发一张酒标/酒瓶照片给我，我帮你检查日期和新鲜度。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [],
    };
  }
}
