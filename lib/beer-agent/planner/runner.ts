/**
 * Plan Runner — executes plan steps sequentially with tracing.
 *
 * Every step is executed in order. On failure, remaining steps are skipped
 * and a graceful fallback reply is generated.
 *
 * The runner does NOT execute steps in parallel — each step must complete
 * before the next begins. This ensures deterministic, traceable execution.
 */

import type {
  Plan,
  PlanStep,
  PlannerContext,
  PlannerResult,
} from "./types";
import type { AgentResponse, Pick } from "@/lib/beer-agent/types";
import type { BeerCandidate } from "@/lib/beer-agent/types";
import { validatePlan } from "./planner";
import type { ToolRegistry } from "./tools";
import { emptyPicks } from "@/lib/beer-agent/handler-types";

/**
 * Execute a plan: validate, run steps sequentially, handle failures.
 */
export async function runPlanner(
  plan: Plan,
  toolRegistry: ToolRegistry,
  context: PlannerContext,
): Promise<PlannerResult> {
  // ── Validate ──
  const validation = validatePlan(plan, toolRegistry);
  if (!validation.valid) {
    // Plan is invalid — return fallback immediately
    plan.diagnostics.fallbackUsed = true;
    return {
      plan,
      success: false,
      fallback: true,
      finalReply:
        "抱歉，处理你的请求时内部配置出错了。请换个方式重试。",
      candidates: [],
      picks: emptyPicks(),
      profileSummary: "",
    };
  }

  // ── Collect tool outputs for compose_answer ──
  const toolOutputs: Record<string, unknown> = {};

  // ── Execute steps sequentially ──
  let allSucceeded = true;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    // Skip if previous step failed
    if (!allSucceeded) {
      step.status = "skipped";
      continue;
    }

    step.status = "running";
    step.startedAt = new Date().toISOString();

    const tool = toolRegistry.get(step.tool);
    if (!tool) {
      step.status = "failed";
      step.error = `Tool "${step.tool}" not found in registry`;
      step.completedAt = new Date().toISOString();
      allSucceeded = false;
      continue;
    }

    // ── Special handling for compose_answer: inject previous tool outputs ──
    let input = { ...step.input };
    if (step.tool === "compose_answer") {
      input = {
        ...input,
        toolOutputs: { ...toolOutputs },
      };
      // Update the step input for trace accuracy
      (step.input as any).toolOutputs = { ...toolOutputs };
    }

    // ── Special handling for score_recommendations: inject profile ──
    if (step.tool === "score_recommendations") {
      const memOutput = toolOutputs["retrieve_memory"] as any;
      if (memOutput?.profile) {
        input = { ...input, profile: memOutput.profile };
        (step.input as any).profile = "[injected from retrieve_memory]";
      }
      // Also inject candidates from search_beer_db
      const dbOutput = toolOutputs["search_beer_db"] as any;
      if (dbOutput?.results && Array.isArray(dbOutput.results)) {
        const candidates: BeerCandidate[] = dbOutput.results
          .filter((r: any) => r.found && r.data)
          .map((r: any, idx: number) => ({
            candidateId: `db_${idx}`,
            menuIndex: idx,
            displayName: r.data.beerName || r.query,
            brewery: r.data.brewery || "",
            style: r.data.style || "",
            abv: r.data.abv ?? 0,
            ibu: null,
            hops: [],
            worthScore: 50,
            fitScore: 50,
            riskFlags: [],
            reason: "",
            evidence: [],
            untappdScore: r.data.rating ?? null,
            untappdRatingCount: r.data.ratingCount ?? null,
          }));
        if (candidates.length > 0) {
          input = { ...input, candidates };
          (step.input as any).candidates = `[${candidates.length} candidates from search_beer_db]`;
        }
      }
    }

    // ── Execute with timeout ──
    try {
      const result = await executeWithTimeout(
        () => tool.execute(input, context),
        tool.timeoutMs,
      );

      step.status = "completed";
      step.output = result;
      step.completedAt = new Date().toISOString();

      // Store output for compose_answer
      toolOutputs[step.tool] = result;
    } catch (err) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
      step.completedAt = new Date().toISOString();
      allSucceeded = false;
    }
  }

  // ── Build final reply ──
  const composeOutput = toolOutputs["compose_answer"] as any;
  const clarifyOutput = toolOutputs["ask_clarifying_question"] as any;
  const scoringOutput = toolOutputs["score_recommendations"] as any;

  let finalReply: string;
  let candidates: BeerCandidate[] = [];
  let picks: AgentResponse["picks"] = emptyPicks();
  let profileSummary = "";

  if (allSucceeded && composeOutput?.reply) {
    finalReply = composeOutput.reply;
    candidates = (composeOutput.candidates as BeerCandidate[]) ?? [];
    picks = (composeOutput.picks as AgentResponse["picks"]) ?? emptyPicks();
    profileSummary = composeOutput.profileSummary ?? "";
  } else if (allSucceeded && clarifyOutput?.question) {
    finalReply = clarifyOutput.question;
    profileSummary = "";
  } else {
    // Fallback: compose a graceful reply from whatever succeeded
    plan.diagnostics.fallbackUsed = true;
    const memoryOutput = toolOutputs["retrieve_memory"] as any;
    if (memoryOutput?.profile?.summary) {
      profileSummary = memoryOutput.profile.summary;
    }

    if (scoringOutput?.picks) {
      candidates = (scoringOutput.scored as BeerCandidate[]) ?? [];
      picks = scoringOutput.picks as AgentResponse["picks"];
      finalReply = "根据你的口味画像，我找到了以下推荐。不过处理过程中遇到了一些问题，结果可能不够完整。";
    } else if (memoryOutput?.profile) {
      finalReply = `我查看了你的口味偏好（${profileSummary || "暂无详细记录"}），但这次没能完成完整的推荐流程。你可以再详细说说你的需求吗？`;
    } else {
      finalReply = "抱歉，处理你的请求时出了一些问题。你可以换个方式重新描述你的需求吗？";
    }
  }

  plan.finalAnswer = finalReply;

  return {
    plan,
    success: allSucceeded,
    fallback: plan.diagnostics.fallbackUsed,
    finalReply,
    candidates,
    picks,
    profileSummary,
  };
}

/**
 * Convert a PlannerResult to the existing BeerDialogResponse shape.
 * This ensures backward compatibility with the API response contract.
 */
export function planResultToResponse(
  result: PlannerResult,
  traceId: string,
): AgentResponse & { stages?: Record<string, unknown> } {
  return {
    mode: "recommend",
    reply: result.finalReply,
    candidates: result.candidates,
    picks: result.picks,
    profileSummary: result.profileSummary,
    stages: {
      planner: {
        plan: result.plan,
        planId: result.plan.id,
        reason: result.plan.reason,
        success: result.success,
        fallback: result.fallback,
        steps: result.plan.steps.map((s) => ({
          id: s.id,
          tool: s.tool,
          purpose: s.purpose,
          status: s.status,
          error: s.error,
          outputSummary: summarizeOutput(s),
        })),
        diagnostics: result.plan.diagnostics,
      },
    },
  };
}

/** Summarize step output for the response stages (avoid huge payloads) */
function summarizeOutput(step: PlanStep): unknown {
  if (!step.output) return null;
  if (typeof step.output === "object") {
    // Truncate large outputs
    const str = JSON.stringify(step.output);
    if (str.length > 500) {
      return { _truncated: true, _size: str.length, _preview: str.slice(0, 200) + "..." };
    }
    return step.output;
  }
  return step.output;
}

// ── Timeout helper ──

async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return fn();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
