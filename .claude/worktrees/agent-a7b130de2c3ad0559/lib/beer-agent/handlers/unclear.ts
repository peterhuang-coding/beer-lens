import type { BeerDialogRequest } from "@/lib/beer-agent/dialog-types";
import type { HandlerContext } from "@/lib/beer-agent/handler-types";
import type { AgentResponse } from "@/lib/beer-agent/types";
import { emptyPicks } from "@/lib/beer-agent/handler-types";

export async function handleUnclear(
  request: BeerDialogRequest,
  context: HandlerContext
): Promise<AgentResponse> {
  const hasImage = !!request.image;
  const reply = hasImage
    ? "你是想让我看酒单推荐，还是检查这瓶酒的信息？"
    : "你是想推荐啤酒、记录喝过的酒，还是了解啤酒知识？";

  return {
    mode: "recommend",
    reply,
    candidates: [],
    picks: emptyPicks(),
    profileSummary: "",
  };
}
