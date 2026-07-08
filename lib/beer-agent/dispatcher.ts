import type { BeerDialogRequest, IntentResult, IntentItem } from "./dialog-types";
import type { AgentResponse } from "./types";
import type { HandlerContext } from "./handler-types";
import { emptyPicks } from "./handler-types";
import { handleMenuRecommend } from "./handlers/menu-recommend";
import { handleFollowUpFilter } from "./handlers/follow-up-filter";
import { handleTastingFeedback } from "./handlers/tasting-feedback";
import { handleProfileQuery } from "./handlers/profile-query";
import { handleBeerKnowledge } from "./handlers/beer-knowledge";
import { handleLabelCheck } from "./handlers/label-check";
import { handleMemoryCorrection } from "./handlers/memory-correction";
import { handleUnclear } from "./handlers/unclear";
import { getIntent } from "./intent-registry";
import {
  type RouteDefinition,
  type RouteDiagnosis,
  type RouteContextSnapshot,
  diagnoseRoute,
  getRoute,
  getRouteTable,
} from "./route-registry";

/** Handler function map — intent → actual handler */
const handlerMap: Record<
  string,
  (request: BeerDialogRequest, context: HandlerContext) => Promise<AgentResponse>
> = {
  menu_recommend: handleMenuRecommend,
  follow_up_filter: handleFollowUpFilter,
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
  const intentDef = getIntent(context.isMultiIntent
    ? request.messages.at(-1)?.content ?? "custom"
    : request.messages.at(-1)?.content ?? "custom");
  const lastUserText = request.messages.at(-1)?.content ?? "";

  return {
    mode: "recommend",
    reply: `收到你的消息。我目前对「${intentDef?.label || "这个需求"}」还在学习中，你可以换个方式说说看？`,
    candidates: [],
    picks: emptyPicks(),
    profileSummary: context.memorySnapshot?.profileSummary ?? "",
  };
}

/** Build a RouteContextSnapshot from the handler context */
function buildRouteContext(
  request: BeerDialogRequest,
  context: HandlerContext,
): RouteContextSnapshot {
  const ms = context.memorySnapshot?.shortTerm;
  return {
    hasImage: !!request.image?.dataUrl,
    lastMenu: (ms?.lastMenuCandidateCount ?? 0) > 0,
    activeBeer: ms?.activeBeerName != null && ms.activeBeerName !== "未知啤酒",
    profileSummary: (context.memorySnapshot?.profileSummary?.length ?? 0) > 0,
    tastingHistory: false, // Not exposed in memory snapshot yet — handlers check independently
  };
}

export async function dispatchByIntent(
  request: BeerDialogRequest,
  intentResult: IntentResult,
  context: HandlerContext,
): Promise<AgentResponse> {
  const intent = intentResult.intent;

  // ── Route diagnosis: check context availability ──
  const routeContext = buildRouteContext(request, context);
  const diagnosis = diagnoseRoute(intent, routeContext);
  const route = getRoute(intent);

  // ── Resolve handler ──
  // If fallback was triggered by missing context AND fallbackIntent is set,
  // try that handler first. Otherwise use the diagnosis-selected handler.
  let handler = handlerMap[intent] ?? handleCustom;
  let effectiveIntent = intent;

  if (diagnosis.fallbackUsed && diagnosis.fallbackIntent) {
    const fallbackHandler = handlerMap[diagnosis.fallbackIntent];
    if (fallbackHandler) {
      handler = fallbackHandler;
      effectiveIntent = diagnosis.fallbackIntent;
    }
  }

  // ── Multi-intent support ──
  const secondaryIntents: IntentItem[] | undefined = intentResult.isMultiIntent
    ? intentResult.intents.filter(i => i.intent !== intent)
    : undefined;

  const handlerContext: HandlerContext = {
    ...context,
    secondaryIntents,
    isMultiIntent: intentResult.isMultiIntent,
  };

  try {
    const response = await handler(request, handlerContext);

    // ── Inject route diagnosis into response ──
    response.routeDiagnosis = diagnosis;

    // ── If multi-intent, enrich reply with secondary intent context ──
    if (secondaryIntents && secondaryIntents.length > 0) {
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
      `[dispatcher] handler "${effectiveIntent}" (intent: "${intent}") failed:`,
      err,
    );

    // ── Route-aware error fallback ──
    const errorDiagnosis: RouteDiagnosis = {
      ...diagnosis,
      fallbackUsed: true,
      routeReason: `${diagnosis.routeReason} → handler threw: ${err instanceof Error ? err.message : "unknown error"}`,
    };

    return {
      mode: "recommend",
      reply: route?.fallbackReply ?? "抱歉，处理你的请求时出错了。请再试一次。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
      routeDiagnosis: errorDiagnosis,
    };
  }
}

/** Export for debug / introspection */
export { getRouteTable as getRouteRegistry };
