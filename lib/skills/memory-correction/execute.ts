import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  const { parseCorrections, appendCorrection, describeCorrection } = await import("@/lib/beer-agent/memory/corrections");
  const { rebuildProfileMemory } = await import("@/lib/beer-agent/memory/profile");

  const corrections = parseCorrections(ctx.lastUserText);

  if (corrections.length === 0) {
    return {
      skillId: "memory-correction",
      reply:
        "我不太确定你想纠正什么。你可以说：\n" +
        "  •「我不是不喜欢IPA，我是不喜欢太苦的」\n" +
        "  •「我其实喜欢酸啤」\n" +
        "  •「别再说我喜欢世涛」\n" +
        "这样我就能帮你调整口味画像了。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      errors: [],
    };
  }

  // Persist each correction
  for (const correction of corrections) {
    await appendCorrection(ctx.userId, {
      action: correction.action,
      targetValue: correction.targetValue,
      sourceText: ctx.lastUserText,
    });
  }

  // Rebuild profile
  const profile = await rebuildProfileMemory(ctx.userId);

  const correctionDescriptions = corrections.map((c) => describeCorrection(c));
  const reply = [
    "好的，已记录你的纠正：",
    ...correctionDescriptions.map((d) => `  • ${d}`),
    "",
    `你的口味画像已更新：${profile.summary}`,
    profile.evidenceCount > 0
      ? `画像置信度：${Math.round(profile.confidence * 100)}%（基于 ${profile.evidenceCount} 条品饮记录）`
      : "",
  ].filter(Boolean).join("\n");

  return {
    skillId: "memory-correction",
    reply,
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
    errors: [],
  };
}
