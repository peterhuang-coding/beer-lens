import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  const hasImage = ctx.hasImage;
  const reply = hasImage
    ? "你是想让我看酒单推荐，还是检查这瓶酒的信息？"
    : "你是想推荐啤酒、记录喝过的酒，还是了解啤酒知识？";

  return {
    skillId: "fallback",
    reply,
    candidates: [],
    picks: emptyPicks(),
    profileSummary: "",
    errors: [],
  };
}
