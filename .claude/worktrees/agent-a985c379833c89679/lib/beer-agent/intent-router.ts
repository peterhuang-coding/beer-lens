/**
 * Intent Router — detects user intent and routes to the right handler.
 *
 * 6 intents:
 *   1. menu_recommend   — photo + optional text
 *   2. follow_up         — text with prior menu in history
 *   3. tasting_feedback  — text with rating/feedback signals
 *   4. knowledge         — beer Q&A (LLM handles)
 *   5. label_check       — photo of single bottle/can
 *   6. profile           — user asks about their taste profile
 */
import type { AgentRequest, AgentResponse } from "./types";
import type { PipelineEvent } from "./multi-stage-pipeline";
import { runMultiStagePipeline } from "./multi-stage-pipeline";
import { runOpenRouterBeerAgent } from "./openrouter-provider";
import { getProfileSummary } from "./profile";

export type Intent =
  | "menu_recommend"
  | "follow_up"
  | "tasting_feedback"
  | "knowledge"
  | "label_check"
  | "profile";

export type ProgressCallback = (event: PipelineEvent) => void;

// ── Intent detection ──

export function detectIntent(request: AgentRequest): Intent {
  const hasImage = !!request.image?.dataUrl;
  const text = request.messages.at(-1)?.content ?? "";

  // Check feedback signals first
  if (looksLikeFeedback(text)) return "tasting_feedback";

  // Check profile inquiry
  if (/我的口味|口味画像|喝过什么|我的记录|profile|偏好/.test(text)) return "profile";

  // Check knowledge questions
  if (!hasImage && /什么是|风格|酿造|区别|怎么|为什么|定义|解释/.test(text)) return "knowledge";

  // Image intents
  if (hasImage) {
    if (/酒标|这瓶|这罐|帮我看|日期|生产日期|过期/.test(text)) return "label_check";
    return "menu_recommend";
  }

  // Follow-up: has prior menu candidates in conversation
  if (hasPriorMenuInHistory(request)) return "follow_up";

  return "knowledge"; // default: chat
}

// ── Main dispatcher ──

export async function routeIntent(
  request: AgentRequest,
  onProgress?: ProgressCallback,
): Promise<AgentResponse> {
  const intent = detectIntent(request);

  switch (intent) {
    case "menu_recommend":
      return handleMenuRecommend(request, onProgress);
    case "follow_up":
      return handleFollowUp(request);
    case "tasting_feedback":
      return handleTastingFeedback(request);
    case "label_check":
      return handleMenuRecommend(request, onProgress); // reuse vision pipeline
    case "profile":
      return handleProfile();
    case "knowledge":
    default:
      return handleKnowledge(request);
  }
}

// ── Handlers ──

async function handleMenuRecommend(
  request: AgentRequest,
  onProgress?: ProgressCallback,
): Promise<AgentResponse> {
  const profileSummary = await getProfileSummary();

  if (!request.image?.dataUrl) {
    return {
      mode: "recommend",
      reply: "请发一张酒单照片给我，我帮你选。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary,
    };
  }

  const pipeline = await runMultiStagePipeline({
    apiKey: process.env.OPENROUTER_API_KEY!,
    imageDataUrl: request.image.dataUrl,
    userText: request.messages.at(-1)?.content ?? "帮我看这张酒单并推荐",
    profile: profileSummary,
    onProgress: onProgress ?? (() => {}),
  });

  // Build response from pipeline output
  const extracted = pipeline.extracted?.items ?? [];
  const rec = pipeline.recommendation;

  // For now, return pipeline result as-is (enrichment happens in provider.ts)
  const reply = rec.reply || buildFallbackReply(extracted);

  return {
    mode: "recommend",
    reply,
    candidates: extracted.map((item, i) => ({
      candidateId: String(i + 1),
      menuIndex: item.menuIndex || i + 1,
      displayName: item.beerName,
      brewery: item.brewery,
      style: item.style,
      abv: item.abv,
      ibu: item.ibu,
      hops: [],
      worthScore: 50,
      fitScore: 50,
      riskFlags: [],
      reason: "",
      evidence: [],
      price: item.price,
      volumeMl: parseServingMl(item.serving),
    })),
    picks: {
      topPick: { candidateId: rec.topPickId, label: "最佳选择", reason: rec.topReason, worthScore: 50, fitScore: 50 },
      safePick: { candidateId: rec.safePickId, label: "最稳", reason: rec.safeReason, worthScore: 50, fitScore: 50 },
      explorePick: { candidateId: rec.explorePickId, label: "尝新", reason: rec.exploreReason, worthScore: 50, fitScore: 50 },
      avoidOrCaution: { candidateId: rec.avoidPickId, label: "谨慎", reason: rec.avoidReason, worthScore: 50, fitScore: 50 },
    },
    profileSummary,
    stages: pipeline as any,
  };
}

async function handleFollowUp(request: AgentRequest): Promise<AgentResponse> {
  // Delegate to existing text handler which uses conversation history
  return runOpenRouterBeerAgent(request);
}

async function handleTastingFeedback(request: AgentRequest): Promise<AgentResponse> {
  const result = await runOpenRouterBeerAgent(request);
  return { ...result, mode: "benchmark" };
}

async function handleKnowledge(request: AgentRequest): Promise<AgentResponse> {
  return runOpenRouterBeerAgent(request);
}

async function handleProfile(): Promise<AgentResponse> {
  const profileSummary = await getProfileSummary();
  return {
    mode: "recommend",
    reply: `你的口味画像：\n\n${profileSummary}`,
    candidates: [],
    picks: emptyPicks(),
    profileSummary,
  };
}

// ── Helpers ──

function looksLikeFeedback(text: string): boolean {
  return (
    /\b[1-5](?:\.\d+)?\s*分\b/.test(text) ||
    /会再喝|不会再喝|看情况/.test(text) ||
    (/喝了/.test(text) && /\d/.test(text))
  );
}

function hasPriorMenuInHistory(request: AgentRequest): boolean {
  // Check if any assistant message contains beer candidates
  return request.messages.some(m =>
    m.role === "assistant" &&
    (m.content.includes("candidateId") || m.content.includes("推荐") || m.content.includes("酒单"))
  );
}

function parseServingMl(serving: string): number | null {
  if (!serving) return null;
  const m = serving.match(/(\d+)\s*ml/i);
  if (m) return parseInt(m[1], 10);
  if (/品脱|pint/i.test(serving)) return 473;
  return null;
}

function buildFallbackReply(items: any[]): string {
  if (items.length === 0) return "这张图里我没能识别出啤酒。试试拍清楚一点？";
  const names = items.slice(0, 5).map((i: any) => i.beerName).join("、");
  return `识别到 ${items.length} 款酒：${names}。我会推荐最适合你的。`;
}

function emptyPicks() {
  const e = { candidateId: "", label: "", reason: "暂无", worthScore: 0, fitScore: 0 };
  return { topPick: e, safePick: e, explorePick: e, avoidOrCaution: e };
}
