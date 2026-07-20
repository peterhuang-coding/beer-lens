/**
 * Menu Vision Skill — OCR + vision analysis of beer menu photos.
 * Used internally by the recommend skill.
 */
import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  if (!ctx.imageDataUrl) {
    return {
      skillId: "menu-vision",
      reply: "需要一张酒单照片才能分析。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: ["No image provided"],
    };
  }

  try {
    const { runImagePipeline } = await import("@/lib/beer-agent/provider");
    const { getProfileSummary } = await import("@/lib/beer-agent/profile");

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

    const profileSummary = await getProfileSummary();
    const pipelineResult = await runImagePipeline(
      apiKey,
      ctx.imageDataUrl,
      ctx.lastUserText,
      profileSummary,
    );

    // Return raw pipeline results without scoring (caller handles scoring)
    return {
      skillId: "menu-vision",
      reply: `识别到 ${pipelineResult.candidates.length} 款啤酒`,
      candidates: pipelineResult.candidates,
      picks: emptyPicks(),
      profileSummary,
      data: {
        candidateCount: pipelineResult.candidates.length,
        stages: pipelineResult.stages,
      },
      errors: [],
    };
  } catch (err) {
    return {
      skillId: "menu-vision",
      reply: "分析酒单照片时出错。请确保照片清晰。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
