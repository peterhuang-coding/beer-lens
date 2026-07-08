import type { BeerDialogRequest, MemorySnapshot, IntentResult, IntentItem } from "./dialog-types";
import type { AgentRequest, AgentResponse } from "./types";

export type HandlerContext = {
  traceId: string;
  memorySnapshot?: MemorySnapshot;
  /** Multi-intent support: secondary intents that also matched */
  secondaryIntents?: IntentItem[];
  /** Whether this turn was triggered by a multi-intent match */
  isMultiIntent?: boolean;
  /** Errors caught by handler internally (non-thrown fallbacks) */
  handlerErrors?: Array<{ message: string; model?: string; stack?: string }>;
};

export type IntentHandler = (
  request: BeerDialogRequest,
  context: HandlerContext
) => Promise<AgentResponse>;

export function emptyPicks(): AgentResponse["picks"] {
  const empty = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return {
    topPick: empty,
    safePick: empty,
    explorePick: empty,
    avoidOrCaution: empty,
  };
}

export function toAgentRequest(
  request: BeerDialogRequest,
  mode?: AgentRequest["mode"]
): AgentRequest {
  return {
    mode,
    messages: request.messages,
    image: request.image?.dataUrl ? request.image : undefined,
  };
}
