import type { AgentResponse, ChatMessage } from "./types";

export type BeerChannel = "web" | "feishu" | "wechat" | "telegram" | "cli";

export type IntentContext = {
  hasImage: boolean;
  lastUserText: string;
  hasLastMenuCandidates: boolean;
  hasLastRecommendation: boolean;
  /** Number of candidates from the last menu (0 if no active menu) */
  activeMenuCandidateCount: number;
  /** How many turns since the last menu was uploaded */
  turnsSinceLastMenu: number;
  profileSummary?: string;
};

/** Known built-in intent ids. The system supports dynamic registration of custom intents. */
export const KNOWN_INTENTS = [
  "menu_recommend",
  "tasting_feedback",
  "profile_query",
  "beer_knowledge",
  "label_check",
  "memory_correction",
  "unclear",
] as const;

export type BuiltinIntent = (typeof KNOWN_INTENTS)[number];

/** Intent id — built-in or custom. Open `string` for extensibility. */
export type BeerIntent = string;

/** A single intent match — supports multi-intent detection */
export type IntentItem = {
  intent: BeerIntent;
  confidence: number;
  slots: Record<string, unknown>;
};

export type IntentResult = {
  /** All matched intents (when multiple rules fire with similar confidence) */
  intents: IntentItem[];
  /** Primary intent — the highest-confidence one, used for routing */
  intent: BeerIntent;
  /** Confidence of the primary intent */
  confidence: number;
  /** Slots extracted from the primary intent */
  slots: Record<string, unknown>;
  missingInfo: string[];
  routeReason: string;
  source: "rule" | "llm" | "fallback";
  /** Whether this is a multi-intent match */
  isMultiIntent: boolean;
};

export type MemorySnapshot = {
  shortTerm?: {
    lastMenuCandidateCount?: number;
    hasLastRecommendation?: boolean;
    activeBeerName?: string | null;
  };
  profileSummary?: string;
};

export type MemoryDelta = {
  wroteShortTerm: boolean;
  wroteEpisodic: boolean;
  updatedProfile: boolean;
  notes: string[];
};

export type DebugInfo = {
  route?: string;
  usedLegacyAgent?: string;
  hasImage?: boolean;
  modelNames?: {
    vision?: string;
    analysis?: string;
    chat?: string;
  };
  warnings?: string[];
};

export type TraceRecord = {
  traceId: string;
  userId: string;
  channel: BeerChannel;
  conversationId: string;
  turnId: string;
  timestamp: string;
  input: {
    messageCount: number;
    lastUserText: string;
    hasImage: boolean;
    imageName?: string;
    imageType?: string;
  };
  intentResult: IntentResult;
  memorySnapshot?: MemorySnapshot;
  memoryDelta: MemoryDelta;
  route: {
    handler: string;
    usedLegacyAgent?: string;
  };
  output: {
    mode: string;
    reply: string;
    candidateCount: number;
    topPickId?: string;
    overallRating?: string;
  };
  stages?: Record<string, unknown>;
  errors: Array<{ message: string; stack?: string }>;
  debug?: DebugInfo;
};

export type BeerDialogRequest = {
  userId: string;
  channel: BeerChannel;
  conversationId: string;
  turnId: string;
  messages: ChatMessage[];
  image?: { name: string; type: string; dataUrl?: string; };
  metadata?: { locale?: string; timezone?: string; venue?: string; };
};

export type BeerDialogResponse = AgentResponse & {
  traceId: string;
  userId: string;
  channel: BeerChannel;
  conversationId: string;
  turnId: string;
  intentResult: IntentResult;
  memoryDelta: MemoryDelta;
  debug?: DebugInfo;
};

export function generateTraceId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `trace_${Date.now()}_${suffix}`;
}
