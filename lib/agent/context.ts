/**
 * Agent Context Builder — aggregates memory, profile, and conversation state
 * into a unified AgentContext for skill execution.
 */

import type { AgentContext } from "./types";
import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import { readShortTermMemory } from "@/lib/beer-agent/memory/short-term";
import { getProfileMemory } from "@/lib/beer-agent/memory/profile";
import { isMemoryReadEnabled } from "@/lib/beer-agent/memory/memory-experiment";
import { createTraceId } from "@/lib/beer-agent/trace";

/**
 * Build the full AgentContext from a BeerDialogRequest.
 * Reads short-term memory and profile in parallel.
 */
export async function buildAgentContext(
  request: BeerDialogRequest,
): Promise<AgentContext> {
  const traceId = createTraceId();
  const lastUserText = request.messages.at(-1)?.content ?? "";
  const hasImage = !!request.image?.dataUrl;

  // Read memory in parallel
  const [stm, profile] = await Promise.all([
    readShortTermMemory(request.conversationId, request.userId).catch(() => null),
    readProfile(request.userId),
  ]);

  // Detect active menu from short-term memory or message history
  const menuCandidateCount = stm?.lastMenu?.candidates?.length ?? 0;

  const memorySnapshot = {
    shortTerm: {
      lastMenuCandidateCount: menuCandidateCount,
      hasLastRecommendation: stm?.lastPicks != null,
      activeBeerName: stm?.activeBeer?.displayName ?? null,
    },
    profileSummary: profile?.summary,
  };

  return {
    userId: request.userId,
    conversationId: request.conversationId,
    traceId,
    hasImage,
    imageDataUrl: request.image?.dataUrl,
    imageName: request.image?.name,
    imageType: request.image?.type,
    lastUserText,
    messages: request.messages,
    channel: request.channel,
    memorySnapshot,
    profileSummary: profile?.summary,
  };
}

async function readProfile(userId: string) {
  const enabled = await isMemoryReadEnabled(userId).catch(() => false);
  if (!enabled) return null;
  return getProfileMemory(userId).catch(() => null);
}

/** Get a one-line description of the conversation for prompt building */
export function describeContext(ctx: AgentContext): string {
  const parts: string[] = [];
  if (ctx.hasImage) parts.push("有图片");
  if (ctx.memorySnapshot?.shortTerm?.lastMenuCandidateCount) {
    parts.push(
      `有活跃酒单(${ctx.memorySnapshot.shortTerm.lastMenuCandidateCount}款)`,
    );
  }
  if (ctx.memorySnapshot?.shortTerm?.activeBeerName) {
    parts.push(`正在讨论：${ctx.memorySnapshot.shortTerm.activeBeerName}`);
  }
  if (ctx.profileSummary && !ctx.profileSummary.includes("还没有正式记录")) {
    parts.push("有口味画像");
  }
  return parts.length > 0 ? parts.join("，") : "无特殊上下文";
}
