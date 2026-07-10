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
  "follow_up_filter",
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

/** Detailed diagnosis of intent classification for debugging badcases. */
export type IntentDiagnosis = {
  matchedRules: Array<{ intentId: string; ruleId: string; confidence: number; pattern: string }>;
  matchedSamples: Array<{ intentId: string; score: number; sampleText: string }>;
  negativeRulesHit: Array<{ intentId: string; ruleId: string; pattern: string }>;
  contextSignals: {
    hasImage: boolean;
    hasActiveMenu: boolean;
    turnsSinceMenu: number;
    activeMenuCandidateCount: number;
    hasTastingHistory: boolean;
  };
  threshold: number;
  fallbackReason?: string;
  finalDecisionReason: string;
  candidateScores: Array<{ intentId: string; label: string; score: number; source: string; reason: string }>;
  ruleTrace: Array<{ intentId: string; ruleId: string; type: string; matched: boolean; confidence?: number; reason: string }>;
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
  diagnosis?: IntentDiagnosis;
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
  /** Route diagnosis: selected handler, context check, tools, fallback info */
  routeDiagnosis?: import("./route-registry").RouteDiagnosis;
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
    imageUrl?: string;
  };
  intentResult: IntentResult;
  memorySnapshot?: MemorySnapshot;
  memoryDelta: MemoryDelta;
  route: {
    handler: string;
    usedLegacyAgent?: string;
    /** Route diagnosis: selected handler, context check, tools, fallback info */
    diagnosis?: import("./route-registry").RouteDiagnosis;
  };
  output: {
    mode: string;
    reply: string;
    candidateCount: number;
    topPickId?: string;
    overallRating?: string;
  };
  stages?: Record<string, unknown>;
  errors: Array<{
    message: string;
    stack?: string;
    /** Which LLM provider/model was used when the error occurred. */
    model?: string;
    provider?: string;
    /** HTTP status code or error code from the provider. */
    errorCode?: string;
  }>;
  debug?: DebugInfo;
  /** Planner trace data — only set when the planner was used. */
  planner?: {
    plan: {
      id: string;
      reason: string;
      mode: string;
      maxSteps: number;
      steps: Array<{
        id: string;
        tool: string;
        purpose: string;
        status: string;
        input: Record<string, unknown>;
        output?: unknown;
        error?: string;
        startedAt?: string;
        completedAt?: string;
      }>;
      finalAnswer?: string;
    };
    diagnostics: {
      triggerReason: string;
      selectedTools: string[];
      missingContext: string[];
      fallbackUsed: boolean;
      model?: string;
    };
  };
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
  /** Planner diagnostics — only set when the planner was used. */
  planner?: {
    used: boolean;
    triggerReason: string;
    fallbackUsed: boolean;
    stepCount: number;
    toolIds: string[];
  };
};

/** Root cause classification for badcase diagnosis. */
export type RootCause =
  | "ocr"
  | "intent"
  | "beer_db"
  | "recommendation"
  | "prompt"
  | "model"
  | "memory"
  | "guardrail"
  | "planner"
  | "tool_route"
  | "unknown";

export function generateTraceId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `trace_${Date.now()}_${suffix}`;
}
