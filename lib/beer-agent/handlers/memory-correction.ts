import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";
import {
  appendCorrection,
  parseCorrections,
  describeCorrection,
} from "@/lib/beer-agent/memory/corrections";
import { rebuildProfileMemory } from "@/lib/beer-agent/memory/profile";
import { recordMemoryCorrection } from "@/lib/beer-agent/monitor/metrics";

export async function handleMemoryCorrection(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  const userId = request.userId;
  const lastUserText = request.messages.at(-1)?.content ?? "";

  // ── 1. Try to parse correction from text ──
  const corrections = parseCorrections(lastUserText);

  if (corrections.length === 0) {
    return {
      mode: "recommend",
      reply:
        "我不太确定你想纠正什么。你可以说：\n" +
        "  •「我不是不喜欢IPA，我是不喜欢太苦的」\n" +
        "  •「我其实喜欢酸啤」\n" +
        "  •「别再说我喜欢世涛」\n" +
        "这样我就能帮你调整口味画像了。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }

  // ── 2. Persist each correction ──
  recordMemoryCorrection();
  for (const correction of corrections) {
    await appendCorrection(userId, {
      action: correction.action,
      targetValue: correction.targetValue,
      sourceText: lastUserText,
    });
  }

  // ── 3. Rebuild profile with corrections applied ──
  const profile = await rebuildProfileMemory(userId);

  // ── 4. Build confirmation reply ──
  const correctionDescriptions = corrections.map((c) => describeCorrection(c));
  const reply = [
    "好的，已记录你的纠正：",
    ...correctionDescriptions.map((d) => `  • ${d}`),
    "",
    `你的口味画像已更新：${profile.summary}`,
    profile.evidenceCount > 0
      ? `画像置信度：${Math.round(profile.confidence * 100)}%（基于 ${profile.evidenceCount} 条品饮记录）`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    mode: "recommend",
    reply,
    candidates: [],
    picks: emptyPicks(),
    profileSummary: profile.summary,
  };
}
