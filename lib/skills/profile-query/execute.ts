import type { AgentContext, SkillResult } from "@/lib/agent/types";

function emptyPicks(): SkillResult["picks"] {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}

export async function execute(
  ctx: AgentContext,
  _params: Record<string, unknown>,
): Promise<SkillResult> {
  const { getProfileMemory, getTrends } = await import("@/lib/beer-agent/memory/profile");
  const { getMemoryABGroup } = await import("@/lib/beer-agent/memory/memory-experiment");

  const abGroup = await getMemoryABGroup(ctx.userId);
  const profile = await getProfileMemory(ctx.userId);
  const trends = await getTrends(ctx.userId).catch(() => null);

  const lines: string[] = [];
  lines.push(abGroup === "enabled"
    ? "🔬 记忆实验组：开启（你的口味画像会影响推荐）"
    : "🔬 记忆实验组：关闭（推荐不会使用你的历史偏好）");
  lines.push("");
  lines.push("你的口味画像：");
  lines.push("");
  lines.push(profile.summary);
  lines.push("");

  if (profile.evidenceCount > 0) {
    lines.push(`画像置信度：${Math.round(profile.confidence * 100)}%（基于 ${profile.evidenceCount} 条品饮记录）`);
  } else {
    lines.push("画像置信度：暂无足够品饮记录");
  }
  lines.push("");

  if (profile.correctionsCount > 0) {
    lines.push(`用户纠正：已应用 ${profile.correctionsCount} 条手动纠正`);
    lines.push("");
  }

  if (profile.preferredStyles.length > 0) {
    const topStyles = profile.preferredStyles.slice(0, 5).map((s) => `${s.value}（权重 ${s.weight}，${s.evidenceCount}次）`);
    lines.push(`偏好风格：${topStyles.join("、")}`);
  }
  if (profile.dislikedStyles.length > 0) {
    const bottomStyles = profile.dislikedStyles.slice(0, 3).map((s) => `${s.value}（权重 ${s.weight}，${s.evidenceCount}次）`);
    lines.push(`不太喜欢的风格：${bottomStyles.join("、")}`);
  }
  if (profile.preferredTags.length > 0) {
    const topTags = profile.preferredTags.slice(0, 6).map((t) => `${t.value}（${t.weight}）`);
    lines.push(`偏好风味标签：${topTags.join("、")}`);
  }
  if (profile.abvComfortRange) {
    lines.push(`ABV 舒适区：${profile.abvComfortRange.min}% - ${profile.abvComfortRange.max}%（基于 ${profile.abvComfortRange.evidenceCount} 条记录）`);
  }

  if (trends && trends.months.length > 0) {
    const recent = trends.months.slice(-3);
    const totalEpisodes = recent.reduce((sum, m) => sum + m.episodeCount, 0);
    if (totalEpisodes > 0) {
      lines.push("");
      lines.push("📈 最近趋势：");
      const trendParts: string[] = [];
      trendParts.push(recent.map((m) => `${m.month.replace("-", "月")}：${m.episodeCount}款`).join("，"));
      const avgScores = recent.filter((m) => m.avgScore > 0);
      if (avgScores.length > 0) {
        const overallAvg = Math.round((avgScores.reduce((s, m) => s + m.avgScore, 0) / avgScores.length) * 10) / 10;
        trendParts.push(`近三月均分 ${overallAvg}`);
      }
      lines.push(trendParts.join(" · "));
    }
  }

  lines.push("");
  lines.push(`证据数：${profile.evidenceCount} · 画像置信度：${Math.round(profile.confidence * 100)}% · 实验组：${abGroup === "enabled" ? "开启" : "关闭"}`);

  return {
    skillId: "profile-query",
    reply: lines.join("\n"),
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
    errors: [],
  };
}
