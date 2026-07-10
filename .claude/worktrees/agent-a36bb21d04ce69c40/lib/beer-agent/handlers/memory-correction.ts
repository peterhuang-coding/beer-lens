import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";

export async function handleMemoryCorrection(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
  return {
    mode: "recommend",
    reply: "我会在下一版支持纠正功能。目前你可以说'清空'来重置上下文。",
    candidates: [],
    picks: emptyPicks(),
    profileSummary: "",
  };
}
