import type { AgentContext, SkillResult } from "@/lib/agent/types";
import { assembleImageCandidates } from "@/lib/beer-agent/provider";
import { isTurnDeadlineError, throwIfTurnExpired, turnModelOptions } from "@/lib/beer-agent/turn-deadline";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

/** Build the reply from identified fields so free-form prose cannot invent dates. */
export function buildLabelResult(parsed: Record<string, unknown>, profileSummary: string): SkillResult {
  const text = (key: string) => typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
  const beerName = text("beerName");
  const brewery = text("brewery");
  const style = text("style");
  const visibleDate = text("visibleDateText").replace(/[./]/g, "-");
  const dates = [text("packagingDate"), text("productionDate")]
    .map(value => value.replace(/[./]/g, "-"))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && visibleDate.includes(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  const date = dates[0];
  const details = [brewery, beerName].filter(Boolean).join(" / ");
  const reply = [
    details ? `图中酒标识别为 ${details}。` : "未能从图中清楚识别酒名和酒厂。",
    style ? `风格：${style}。` : "",
    typeof parsed.abv === "number" && parsed.abv > 0 ? `酒精度 ${parsed.abv}%。` : "",
    typeof parsed.volumeMl === "number" && parsed.volumeMl > 0 ? `容量 ${parsed.volumeMl}ml。` : "",
    date ? `可见包装/生产日期：${date}。仅凭照片无法确认储存状况或实际新鲜度。` : "包装/生产日期未清楚可见，新鲜度未知。",
  ].filter(Boolean).join(" ");
  const candidates = beerName ? assembleImageCandidates([{
    beerName, brewery, style, abv: typeof parsed.abv === "number" ? parsed.abv : 0,
    serving: typeof parsed.volumeMl === "number" && parsed.volumeMl > 0 ? `${parsed.volumeMl}ml` : "",
    rawText: text("rawText") || details, packagingDate: date ?? "",
  }]) : [];
  if (!date) candidates.forEach(candidate => candidate.riskFlags.push("date_not_visible"));
  return { skillId: "label-check", reply, candidates, picks: emptyPicks(), profileSummary, errors: [] };
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
      throwIfTurnExpired(ctx);
      const { resolveImageRoute } = await import("@/lib/multimodal/image-routing");
      const route = resolveImageRoute();
      const visionModel = route.mode === "legacy" ? await getVisionModel() : "";
      const userText = ctx.lastUserText;

      const prompt = `你是啤酒酒标检查器。分析这张酒瓶/酒罐的照片。

## 任务
1. 识别酒名(beerName)、酒厂(brewery)、风格(style)、ABV、容量(volumeMl)。保留清晰可见的英文专有酒名和酒厂；style 独立填写，不能用 IPA 等风格代替酒名。rawText 逐字保留标签可见原文。
2. 找到包装日期(packagingDate)或生产日期(productionDate)，visibleDateText 逐字抄录可见日期文字。没有清晰可读的日期时三个字段都必须留空。不得从包装设计、酒款上市时间或当前日期推算。
3. 日期格式通常是 "YYYY-MM-DD" 或 "YYYY.MM.DD"
4. 检查酒标是否有可见问题：褪色、破损、液体渗出、变形
5. 日期不可见时 freshnessAssessment 必须为 unknown。照片无法证明实际新鲜度或储存条件。

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
  "visibleDateText": "",
  "rawText": "",
  "issues": [],
  "freshnessAssessment": "fresh|borderline|stale|unknown"
}`;

      let raw: string;
      if (route.mode === "package") {
        const { vision } = await import("@/lib/multimodal/index");
        const match = /^data:([^;]+);base64,(.*)$/.exec(ctx.imageDataUrl);
        const options = turnModelOptions(ctx, 120000);
        const result = await vision.call("beer_label_check", {
          image: {
            base64: match?.[2] ?? ctx.imageDataUrl,
            mime: match?.[1] ?? "image/jpeg",
          },
          prompt,
          maxTokens: 2000,
        }, {
          providers: route.providers.map(provider => ({
            ...provider,
            timeoutMs: options.timeoutMs ?? provider.timeoutMs,
          })),
          signal: options.signal,
        });
        raw = result.raw;
      } else {
        const { openrouterFetch } = await import("@/lib/beer-agent/openrouter-client");
        raw = await openrouterFetch({
          model: visionModel,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: ctx.imageDataUrl } },
            ],
          }],
          temperature: 0.1,
          max_tokens: 2000,
        }, turnModelOptions(ctx, 120000));
      }

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

      return buildLabelResult(parsed, ctx.profileSummary ?? "");
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
    const { agentTextFetch } = await import("@/lib/beer-agent/text-client");
    const raw = await agentTextFetch({
      model: process.env.OPENROUTER_MODEL ?? "qwen/qwen-2.5-72b-instruct",
      messages: [
        { role: "system", content: "你是啤酒专家。用户想了解一款酒的酒标信息（日期、新鲜度等）。用中文简短回答，不要说太多无关内容。如果没有图片，请用户发一张酒标照片。" },
        { role: "user", content: ctx.lastUserText },
      ],
      temperature: 0.3,
      max_tokens: 500,
    }, turnModelOptions(ctx));

    return {
      skillId: "label-check",
      reply: raw.trim(),
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [],
    };
  } catch (err) {
    const expired = isTurnDeadlineError(err) || ctx.signal?.aborted === true;
    return {
      skillId: "label-check",
      reply: expired
        ? "这轮处理超过了时间预算，还没有得到可靠回答。请稍后再试。"
        : "请发一张酒标/酒瓶照片给我，我帮你检查日期和新鲜度。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: expired ? [err instanceof Error ? err.message : String(err)] : [],
    };
  }
}
