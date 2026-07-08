import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import { getProfileMemory, getTrends, type TrendMonth } from "@/lib/beer-agent/memory/profile";
import { getMemoryABGroup } from "@/lib/beer-agent/memory/memory-experiment";

/**
 * Build a Chinese summary of recent trends (last 3 months).
 */
function formatTrendsSummary(months: TrendMonth[]): string | null {
  if (months.length === 0) return null;

  const recent = months.slice(-3);
  const totalEpisodes = recent.reduce((sum, m) => sum + m.episodeCount, 0);

  if (totalEpisodes === 0) return null;

  const parts: string[] = [];

  // Episode count overview
  parts.push(
    recent
      .map((m) => `${m.month.replace("-", "月")}：${m.episodeCount}款`)
      .join("，"),
  );

  // Avg score overview
  const avgScores = recent.filter((m) => m.avgScore > 0);
  if (avgScores.length > 0) {
    const overallAvg = Math.round(
      (avgScores.reduce((s, m) => s + m.avgScore, 0) / avgScores.length) * 10,
    ) / 10;
    parts.push(`近三月均分 ${overallAvg}`);
  }

  // Latest month preferences
  const latest = recent[recent.length - 1];
  if (latest && (latest.topStyles.length > 0 || latest.topTags.length > 0)) {
    const prefs: string[] = [];
    if (latest.topStyles.length > 0) {
      prefs.push(`偏好风格：${latest.topStyles.join("、")}`);
    }
    if (latest.topTags.length > 0) {
      prefs.push(`偏好风味：${latest.topTags.join("、")}`);
    }
    if (prefs.length > 0) {
      parts.push(prefs.join("，"));
    }
  }

  if (parts.length === 0) return null;
  return parts.join(" · ");
}

export async function handleProfileQuery(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  const userId = request.userId;
  const abGroup = await getMemoryABGroup(userId);
  const profile = await getProfileMemory(userId);
  const trends = await getTrends(userId).catch(() => null);

  const lines: string[] = [];

  // ── AB group indicator ──
  lines.push(
    abGroup === "enabled"
      ? "🔬 记忆实验组：开启（你的口味画像会影响推荐）"
      : "🔬 记忆实验组：关闭（推荐不会使用你的历史偏好）",
  );
  lines.push(``);

  lines.push(`你的口味画像：`);
  lines.push(``);
  lines.push(profile.summary);
  lines.push(``);

  if (profile.evidenceCount > 0) {
    lines.push(
      `画像置信度：${Math.round(profile.confidence * 100)}%（基于 ${profile.evidenceCount} 条品饮记录）`,
    );
    lines.push(``);
  } else {
    lines.push(`画像置信度：暂无足够品饮记录`);
    lines.push(``);
  }

  // ── Corrections count ──
  if (profile.correctionsCount > 0) {
    lines.push(
      `用户纠正：已应用 ${profile.correctionsCount} 条手动纠正`,
    );
    lines.push(``);
  }

  if (profile.preferredStyles.length > 0) {
    const topStyles = profile.preferredStyles
      .slice(0, 5)
      .map((s) => `${s.value}（权重 ${s.weight}，${s.evidenceCount}次）`);
    lines.push(`偏好风格：${topStyles.join("、")}`);
  }

  if (profile.dislikedStyles.length > 0) {
    const bottomStyles = profile.dislikedStyles
      .slice(0, 3)
      .map((s) => `${s.value}（权重 ${s.weight}，${s.evidenceCount}次）`);
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
  } else {
    lines.push(`ABV 舒适区：暂无足够记录`);
  }

  if (profile.notes.length > 0) {
    lines.push(`记录数：${profile.notes.length} 条`);
  }

  // ── Recent trends ──
  if (trends && trends.months.length > 0) {
    const trendsText = formatTrendsSummary(trends.months);
    if (trendsText) {
      lines.push(``);
      lines.push(`📈 最近趋势：`);
      lines.push(trendsText);
    }
  }

  // ── Stats footer ──
  lines.push(``);
  lines.push(`证据数：${profile.evidenceCount} · 画像置信度：${Math.round(profile.confidence * 100)}% · 实验组：${abGroup === "enabled" ? "开启" : "关闭"}`);

  return {
    mode: "recommend",
    reply: lines.join("\n"),
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
  };
}
