import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";

export async function handleProfileQuery(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  const userId = request.userId;
  const profile = await getProfileMemory(userId);

  const lines: string[] = [];
  lines.push(`你的口味画像：`);
  lines.push(``);
  lines.push(profile.summary);
  lines.push(``);

  if (profile.preferredStyles.length > 0) {
    const topStyles = profile.preferredStyles
      .slice(0, 5)
      .map((s) => `${s.value}（权重 ${s.weight}）`);
    lines.push(`偏好风格：${topStyles.join("、")}`);
  }

  if (profile.dislikedStyles.length > 0) {
    const bottomStyles = profile.dislikedStyles
      .slice(0, 3)
      .map((s) => `${s.value}（权重 ${s.weight}）`);
    lines.push(`不太喜欢的风格：${bottomStyles.join("、")}`);
  }

  if (profile.preferredTags.length > 0) {
    const topTags = profile.preferredTags
      .slice(0, 6)
      .map((t) => `${t.value}（${t.weight}）`);
    lines.push(`偏好风味标签：${topTags.join("、")}`);
  }

  if (profile.abvComfortRange) {
    lines.push(
      `ABV 舒适区：${profile.abvComfortRange.min}% - ${profile.abvComfortRange.max}%（基于 ${profile.abvComfortRange.evidenceCount} 条记录）`,
    );
  }

  if (profile.notes.length > 0) {
    lines.push(`记录数：${profile.notes.length} 条`);
  }

  return {
    mode: "recommend",
    reply: lines.join("\n"),
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
  };
}
