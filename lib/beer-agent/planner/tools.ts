/**
 * Planner Tool Registry — whitelist-based tool execution.
 *
 * Every planner tool must be registered here. The planner can only invoke
 * tools that are registered AND enabled. This prevents arbitrary function
 * execution and keeps every step traceable.
 */

import type {
  PlanToolId,
  ToolDef,
  PlannerContext,
} from "./types";
import type {
  BeerCandidate,
  Pick,
  AgentResponse,
} from "@/lib/beer-agent/types";
import type { ProfileMemory } from "@/lib/beer-agent/memory/profile";

// ── Tool Registry ──

export class ToolRegistry {
  private tools = new Map<PlanToolId, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.id, tool);
  }

  get(id: PlanToolId): ToolDef | undefined {
    return this.tools.get(id);
  }

  isRegistered(id: string): boolean {
    return this.tools.has(id as PlanToolId);
  }

  getEnabledToolIds(): PlanToolId[] {
    return [...this.tools.values()]
      .filter((t) => t.enabled)
      .map((t) => t.id);
  }

  getAllToolIds(): PlanToolId[] {
    return [...this.tools.keys()];
  }

  /** Check if a tool id is registered AND enabled */
  isExecutable(id: string): boolean {
    const tool = this.tools.get(id as PlanToolId);
    return tool != null && tool.enabled;
  }
}

// ── Helper: simple input validation (check required keys exist) ──

function requireKeys(input: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => k in input && input[k] !== undefined);
}

// ── Tool factories ──

/**
 * classify_intent — wraps the existing intent classifier.
 * Input: { text: string, hasImage?: boolean }
 * Output: IntentResult
 */
export function createClassifyIntentTool(): ToolDef {
  return {
    id: "classify_intent",
    description: "Classify user intent using the existing intent classifier (rule-first + LLM fallback)",
    enabled: true,
    timeoutMs: 15000,
    validate: (input) => requireKeys(input, ["text"]),
    execute: async (_input, context) => {
      const result = context.intentResult;
      return {
        intent: result.intent,
        confidence: result.confidence,
        source: result.source,
        isMultiIntent: result.isMultiIntent,
        intents: result.intents,
        slots: result.slots,
        missingInfo: result.missingInfo,
        routeReason: result.routeReason,
      };
    },
  };
}

/**
 * retrieve_memory — read user profile, trends, and corrections.
 * Input: { userId: string }
 * Output: { profile, trends, corrections }
 */
export function createRetrieveMemoryTool(): ToolDef {
  return {
    id: "retrieve_memory",
    description: "Retrieve user taste profile, monthly trends, and memory corrections",
    enabled: true,
    timeoutMs: 10000,
    validate: (input) => requireKeys(input, ["userId"]),
    execute: async (input, _context) => {
      const userId = String(input.userId);

      const { getProfileMemory, getTrends } = await import(
        "@/lib/beer-agent/memory/profile"
      );
      const { getCorrections } = await import(
        "@/lib/beer-agent/memory/corrections"
      );

      const [profile, trends, correctionsStore] = await Promise.all([
        getProfileMemory(userId).catch(() => null),
        getTrends(userId).catch(() => null),
        getCorrections(userId).catch(() => ({
          userId,
          updatedAt: new Date().toISOString(),
          corrections: [],
        })),
      ]);

      return {
        profile,
        trends: trends
          ? {
              months: trends.months,
              updatedAt: trends.updatedAt,
            }
          : null,
        corrections: correctionsStore.corrections,
        hasProfile: profile != null,
        profileConfidence: (profile as ProfileMemory | null)?.confidence ?? 0,
      };
    },
  };
}

/**
 * search_beer_db — search the beer database for specific beers.
 * Input: { queries: string[] }
 * Output: BeerLookupResult[]
 */
export function createSearchBeerDbTool(): ToolDef {
  return {
    id: "search_beer_db",
    description: "Search the beer database (SQLite + Untappd) for beer data",
    enabled: true,
    timeoutMs: 20000,
    validate: (input) => {
      if (!Array.isArray(input.queries)) return false;
      return input.queries.length > 0 && input.queries.every((q) => typeof q === "string");
    },
    execute: async (input, _context) => {
      const { lookupBeers } = await import("@/lib/beer-agent/beer-db/pipeline");
      const queries = input.queries as string[];
      const results = await lookupBeers(queries);

      return {
        results: results.map((r) => ({
          query: r.query,
          found: r.found,
          data: r.data
            ? (() => {
                const data = r.data as typeof r.data & { ratingCount?: number };
                return {
                  beerName: data.name,
                  brewery: data.brewery,
                  style: data.style,
                  abv: data.abv,
                  rating: data.rating,
                  ratingCount: data.ratings_count ?? data.ratingCount ?? null,
                };
              })()
            : null,
        })),
        totalFound: results.filter((r) => r.found).length,
      };
    },
  };
}

/**
 * score_recommendations — score candidates and select picks.
 * Input: { candidates: BeerCandidate[], profile: ProfileMemory | null, constraints: string[] }
 * Output: { scored: ScoredCandidate[], picks }
 */
export function createScoreRecommendationsTool(): ToolDef {
  return {
    id: "score_recommendations",
    description: "Score beer candidates (worthScore + fitScore) and select picks",
    enabled: true,
    timeoutMs: 10000,
    validate: (input) => {
      if (!Array.isArray(input.candidates)) return false;
      return true; // profile and constraints are optional
    },
    execute: async (input, _context) => {
      const { scoreCandidates, selectPicks } = await import(
        "@/lib/beer-agent/recommendation"
      );

      const candidates = input.candidates as BeerCandidate[];
      const profile = (input.profile as ProfileMemory | null) ?? null;
      const constraints = (input.constraints as string[]) ?? [];

      if (candidates.length === 0) {
        return {
          scored: [],
          picks: emptyPicks(),
          reason: "No candidates to score",
        };
      }

      // Convert BeerCandidate to ScoredCandidate input format
      const scoringInput = candidates.map((c) => ({
        ...c,
        rating: c.untappdScore ?? undefined,
        price: c.price ?? undefined,
        volumeMl: c.volumeMl ?? undefined,
      }));

      const scored = scoreCandidates(scoringInput as any, profile, constraints);
      const picks = selectPicks(scored as any);

      return {
        scored: scored.map((s: any) => ({
          candidateId: s.candidateId,
          displayName: s.displayName,
          worthScore: s.worthScore,
          fitScore: s.fitScore,
          reason: s.reason,
          riskFlags: s.riskFlags,
        })),
        picks,
        candidateCount: scored.length,
      };
    },
  };
}

function emptyPicks(): AgentResponse["picks"] {
  const empty = {
    candidateId: "",
    label: "",
    reason: "暂无",
    worthScore: 0,
    fitScore: 0,
  };
  return {
    topPick: empty,
    safePick: empty,
    explorePick: empty,
    avoidOrCaution: empty,
  };
}

/**
 * update_profile_correction — parse and apply memory corrections.
 * Input: { userId: string, text: string }
 * Output: { corrections: ParsedCorrection[] }
 */
export function createUpdateProfileCorrectionTool(): ToolDef {
  return {
    id: "update_profile_correction",
    description: "Parse user correction text and apply to memory profile",
    enabled: true,
    timeoutMs: 5000,
    validate: (input) => requireKeys(input, ["userId", "text"]),
    execute: async (input, _context) => {
      const { parseCorrections, appendCorrection } = await import(
        "@/lib/beer-agent/memory/corrections"
      );
      const { rebuildProfileMemory } = await import(
        "@/lib/beer-agent/memory/profile"
      );

      const userId = String(input.userId);
      const text = String(input.text);

      const parsed = parseCorrections(text);

      // Append each correction
      for (const c of parsed) {
        await appendCorrection(userId, {
          action: c.action,
          targetValue: c.targetValue,
          sourceText: text,
        }).catch(() => {
          // Best-effort: don't fail the step on append error
        });
      }

      // Rebuild profile to reflect corrections
      let profileUpdated = false;
      try {
        await rebuildProfileMemory(userId);
        profileUpdated = true;
      } catch {
        // Profile rebuild is best-effort
      }

      return {
        corrections: parsed,
        count: parsed.length,
        profileUpdated,
      };
    },
  };
}

/**
 * ask_clarifying_question — generate a clarifying question.
 * Input: { missingContext: string[], previousOutput?: string }
 * Output: { question: string }
 */
export function createAskClarifyingQuestionTool(): ToolDef {
  return {
    id: "ask_clarifying_question",
    description: "Generate a clarifying question when key information is missing",
    enabled: true,
    timeoutMs: 5000,
    validate: (input) => {
      if (!Array.isArray(input.missingContext)) return false;
      return input.missingContext.length > 0;
    },
    execute: async (input, _context) => {
      const missingContext = input.missingContext as string[];

      // Simple template-based question generation
      // Future: could use LLM for more natural questions
      const question = buildClarifyingQuestion(missingContext);

      return { question, missingContext };
    },
  };
}

function buildClarifyingQuestion(missingContext: string[]): string {
  if (missingContext.includes("no_candidates")) {
    return "你需要我先帮你推荐几款酒，还是想了解某款酒的具体信息？可以发张酒单给我看看。";
  }
  if (missingContext.includes("no_profile")) {
    return "我还没有你的口味记录。你可以先告诉我你喜欢什么风格的啤酒（比如IPA、拉格、世涛），或者分享你最近喝过的酒，我会记住你的偏好。";
  }
  if (missingContext.includes("ambiguous_preference")) {
    return "能再说具体一点吗？比如你喜欢偏苦的还是偏清爽的？有没有特别想尝试的风格？";
  }
  if (missingContext.includes("correction_ambiguous")) {
    return "我理解你想调整偏好。能告诉我具体是哪一款酒或哪个风格吗？比如'我其实喜欢酸啤'或'我不喜欢太苦的'。";
  }
  if (missingContext.length === 1) {
    return `我需要更多信息：${missingContext[0]}。能帮我补充一下吗？`;
  }
  return "我还需要更多信息才能给出准确的推荐。能再详细说说你的需求吗？";
}

/**
 * compose_answer — aggregate tool outputs into a final reply.
 * Input: { toolOutputs: Record<string, unknown>, reason: string }
 * Output: { reply: string, candidates?, picks?, profileSummary? }
 */
export function createComposeAnswerTool(): ToolDef {
  return {
    id: "compose_answer",
    description: "Aggregate outputs from previous tool steps into a final reply",
    enabled: true,
    timeoutMs: 10000,
    validate: (input) => {
      if (typeof input.toolOutputs !== "object" || input.toolOutputs == null) return false;
      return typeof input.reason === "string";
    },
    execute: async (input, _context) => {
      const toolOutputs = input.toolOutputs as Record<string, unknown>;
      const reason = String(input.reason);

      // Extract data from previous tool outputs
      const memoryOutput = toolOutputs["retrieve_memory"] as any;
      const scoringOutput = toolOutputs["score_recommendations"] as any;
      const intentOutput = toolOutputs["classify_intent"] as any;
      const correctionOutput = toolOutputs["update_profile_correction"] as any;
      const beerDbOutput = toolOutputs["search_beer_db"] as any;
      const clarifyOutput = toolOutputs["ask_clarifying_question"] as any;

      // If clarifying question was asked, just return it
      if (clarifyOutput?.question) {
        return {
          reply: clarifyOutput.question,
          candidates: [],
          picks: emptyPicks(),
          profileSummary: "",
        };
      }

      // Build reply based on available data
      const parts: string[] = [];

      // Profile-aware greeting
      const profile = memoryOutput?.profile as ProfileMemory | null;
      if (profile && profile.summary && profile.summary !== "暂无足够的品饮记录来生成口味画像。") {
        parts.push(`根据你的口味画像：${profile.summary}`);
      }

      // Scoring results
      if (scoringOutput?.picks && scoringOutput?.picks.topPick?.label) {
        const picks = scoringOutput.picks as AgentResponse["picks"];
        parts.push(
          `推荐首选：${picks.topPick.label}（${picks.topPick.reason}）。` +
            `稳妥选择：${picks.safePick.label}。` +
            `尝新之选：${picks.explorePick.label}。`
        );
      }

      // Correction feedback
      if (correctionOutput?.corrections && correctionOutput.corrections.length > 0) {
        parts.push(`已根据你的反馈调整了口味偏好（${correctionOutput.corrections.length} 项）。`);
      }

      // Beer DB results
      if (beerDbOutput?.totalFound != null) {
        parts.push(`在数据库中找到了 ${beerDbOutput.totalFound} 款相关啤酒。`);
      }

      // Fallback if no structured data
      if (parts.length === 0) {
        parts.push("根据你的需求，我分析了相关信息。");
      }

      // Note: 'reason' is for internal routing only — not shown to users

      const reply = parts.join("\n\n");

      return {
        reply,
        candidates: scoringOutput?.scored ?? [],
        picks: scoringOutput?.picks ?? emptyPicks(),
        profileSummary: profile?.summary ?? "",
      };
    },
  };
}

/**
 * analyze_image — vision pipeline wrapper (L1: wired but still disabled by default).
 * Calls runImagePipeline(apiKey, dataUrl, userText, profileSummary) and returns
 * { candidates, stages }. Errors caught and returned in the same shape as
 * handlers/menu-recommend.ts (candidates:[], stages:{}).
 */
export function createAnalyzeImageTool(): ToolDef {
  return {
    id: "analyze_image",
    description: "Analyze beer label/menu image using vision pipeline (OCR + classification + quality check)",
    enabled: false,
    timeoutMs: 30000,
    validate: (input) => typeof input.imageData === "string",
    execute: async (_input, context) => {
      const imageDataUrl = context.request.image?.dataUrl;
      if (!imageDataUrl) {
        return {
          error: "analyze_image requires request.image.dataUrl",
          candidates: [],
          stages: {},
        };
      }

      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        // Surface as a hard failure so the runner records the step as failed.
        throw new Error("请在 .env.local 中配置 OPENROUTER_API_KEY");
      }

      const lastUserMessage = context.request.messages.at(-1);
      const userText =
        lastUserMessage?.role === "user" ? lastUserMessage.content : "";

      try {
        // Dynamic imports keep circular dependency risk low and let the planner
        // load the vision pipeline only when this tool is actually invoked.
        const { runImagePipeline } = await import("@/lib/beer-agent/provider");
        const { getProfileSummary } = await import("@/lib/beer-agent/profile");

        const profileSummary = await getProfileSummary();

        const pipeline = await runImagePipeline(
          apiKey,
          imageDataUrl,
          userText,
          profileSummary,
        );

        return {
          candidates: pipeline.candidates,
          stages: pipeline.stages,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Mirror handlers/menu-recommend.ts error contract: empty candidates,
        // empty stages, but surface the error message for the runner/trace.
        return {
          error: message,
          candidates: [],
          stages: {},
        };
      }
    },
  };
}

// ── Factory: create the default tool registry with all 8 tools ──

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createClassifyIntentTool());
  registry.register(createRetrieveMemoryTool());
  registry.register(createSearchBeerDbTool());
  registry.register(createScoreRecommendationsTool());
  registry.register(createUpdateProfileCorrectionTool());
  registry.register(createAskClarifyingQuestionTool());
  registry.register(createComposeAnswerTool());
  registry.register(createAnalyzeImageTool());

  return registry;
}
