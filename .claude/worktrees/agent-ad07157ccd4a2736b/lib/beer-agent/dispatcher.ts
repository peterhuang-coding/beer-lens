import type { BeerDialogRequest, IntentResult, IntentItem } from "./dialog-types";
import type { AgentResponse } from "./types";
import type { HandlerContext } from "./handler-types";
import { emptyPicks } from "./handler-types";
import { handleMenuRecommend } from "./handlers/menu-recommend";
import { handleTastingFeedback } from "./handlers/tasting-feedback";
import { handleProfileQuery } from "./handlers/profile-query";
import { handleBeerKnowledge } from "./handlers/beer-knowledge";
import { handleLabelCheck } from "./handlers/label-check";
import { handleMemoryCorrection } from "./handlers/memory-correction";
import { handleUnclear } from "./handlers/unclear";
import { getIntent } from "./intent-registry";

const handlerMap: Record<
  string,
  (request: BeerDialogRequest, context: HandlerContext) => Promise<AgentResponse>
> = {
  menu_recommend: handleMenuRecommend,
  tasting_feedback: handleTastingFeedback,
  profile_query: handleProfileQuery,
  beer_knowledge: handleBeerKnowledge,
  label_check: handleLabelCheck,
  memory_correction: handleMemoryCorrection,
  unclear: handleUnclear,
};

/** Generic LLM-based handler for custom/unknown intents */
async function handleCustom(
  request: BeerDialogRequest,
  context: HandlerContext,
): Promise<AgentResponse> {
  // Try to use the registered intent's prompt if available
  const intentDef = getIntent(context.isMultiIntent
    ? request.messages.at(-1)?.content ?? "custom"
    : request.messages.at(-1)?.content ?? "custom");
  const lastUserText = request.messages.at(-1)?.content ?? "";

  // For custom intents, just respond conversationally
  // (no specialized handler — uses the LLM from intent-classifier's fallback)
  return {
    mode: "recommend",
    reply: `收到你的消息。我目前对「${intentDef?.label || "这个需求"}」还在学习中，你可以换个方式说说看？`,
    candidates: [],
    picks: emptyPicks(),
    profileSummary: context.memorySnapshot?.profileSummary ?? "",
  };
}

export async function dispatchByIntent(
  request: BeerDialogRequest,
  intentResult: IntentResult,
  context: HandlerContext
): Promise<AgentResponse> {
  const handler = handlerMap[intentResult.intent] ?? handleCustom;

  // ── Multi-intent support ──
  // If there are secondary intents, pass them to the handler context
  const secondaryIntents: IntentItem[] | undefined = intentResult.isMultiIntent
    ? intentResult.intents.filter(i => i.intent !== intentResult.intent)
    : undefined;

  const handlerContext: HandlerContext = {
    ...context,
    secondaryIntents,
    isMultiIntent: intentResult.isMultiIntent,
  };

  try {
    const response = await handler(request, handlerContext);

    // ── If multi-intent, enrich reply with secondary intent context ──
    if (secondaryIntents && secondaryIntents.length > 0) {
      // Try to handle secondary intents inline if the handler hasn't already
      const secondaryNotes: string[] = [];
      for (const si of secondaryIntents) {
        if (si.intent === "profile_query" && response.profileSummary) {
          secondaryNotes.push(`顺便说一下，${response.profileSummary}`);
        }
      }
      if (secondaryNotes.length > 0) {
        response.reply = `${response.reply}\n\n${secondaryNotes.join("\n")}`;
      }
    }

    return response;
  } catch (err) {
    console.warn(
      `[dispatcher] handler "${intentResult.intent}" failed:`,
      err
    );
    return {
      mode: "recommend",
      reply: "抱歉，处理你的请求时出错了。请再试一次。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }
}
