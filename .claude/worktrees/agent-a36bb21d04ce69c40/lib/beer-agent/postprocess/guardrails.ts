import type { BeerCandidate, AgentResponse } from "@/lib/beer-agent/types";
import type { IntentResult } from "@/lib/beer-agent/dialog-types";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

let _configCache: any = null;
let _cacheTime = 0;

async function getConfig(): Promise<Record<string, any>> {
  if (_configCache && Date.now() - _cacheTime < 5000) return _configCache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    _configCache = JSON.parse(raw);
    _cacheTime = Date.now();
    return _configCache;
  } catch { return {}; }
}

export type PostprocessContext = {
  intentResult: IntentResult;
  candidates: BeerCandidate[];
  allowedBeerNames: string[];
  sourceSummary: Record<string, unknown>;
};

export type PostprocessResult = {
  response: AgentResponse;
  warnings: string[];
  blocked: boolean;
};

const RATING_PATTERN = /评分[：:]?\s*\d+\.?\d*/;
const DECIMAL_RATING = /\b(\d+(?:\.\d+)?)\b/g;

export async function applyPostprocessGuards(
  response: AgentResponse,
  context: PostprocessContext,
): Promise<PostprocessResult> {
  const warnings: string[] = [];
  const { intentResult, candidates } = context;
  let { reply } = response;
  const pipelineConfig = await getConfig();
  const maxWarnings = pipelineConfig?.config?.["guardrails"]?.["maxWarnings"] ?? 10;

  // ── Rule 1: Candidate reference check ──
  // For recommendation intents, check that the reply references at least
  // SOME of the candidates it recommended. Don't try to parse every token —
  // just verify the candidate names actually appear.
  if (
    candidates.length > 0 &&
    intentResult.intent === "menu_recommend"
  ) {
    const mentionedCount = candidates.filter((c) =>
      reply.includes(c.displayName),
    ).length;
    if (mentionedCount === 0) {
      warnings.push("reply_mentions_no_candidates");
    }
  }

  // ── Rule 2: Verify claimed ratings against actual data ──
  if (mentionsRating(reply)) {
    const ratingValue = extractRatingValue(reply);
    if (ratingValue != null) {
      const matchesCandidate = candidates.some((c) => {
        const cr = c.untappdScore;
        return cr != null && cr > 0 && Math.abs(cr - ratingValue) < 0.1;
      });
      if (!matchesCandidate) {
        warnings.push("unverified_rating_mentioned");
      }
    }
  }

  // ── Rule 3: Low OCR / extraction confidence ──
  for (const candidate of candidates) {
    const confidence = (candidate as Record<string, unknown>).confidence;
    if (typeof confidence === "number" && confidence < 0.6) {
      warnings.push(`low_confidence_candidate: ${candidate.displayName}`);
    }
  }

  // ── Rule 4: High ABV ──
  for (const candidate of candidates) {
    if (candidate.abv > 8) {
      warnings.push(`high_abv_candidate: ${candidate.displayName} (${candidate.abv}%)`);
    }
  }

  // ── Rule 5: Missing data ──
  for (const candidate of candidates) {
    const hasNoRating = candidate.untappdScore == null || candidate.untappdScore === 0;
    if (hasNoRating && reply.includes(candidate.displayName)) {
      const ratingVal = extractRatingValue(reply);
      if (ratingVal != null) {
        warnings.push("missing_data_rating_mentioned");
      }
    }
  }

  // ── Blocking ──
  // Only block on clear-cut hallucination (> 10 warnings indicates systemic failure)
  if (warnings.length > maxWarnings) {
    return {
      response: {
        ...response,
        reply: "我这里不能确认这款酒的数据，先不编评分。你可以发清楚一点的酒单/酒标，我再帮你判断。",
      },
      warnings,
      blocked: true,
    };
  }

  return { response, warnings, blocked: false };
}

function mentionsRating(reply: string): boolean {
  if (RATING_PATTERN.test(reply)) return true;
  const matches = reply.match(DECIMAL_RATING);
  if (!matches) return false;
  return matches.some((m) => {
    const v = parseFloat(m);
    return v >= 1.0 && v <= 10.0;
  });
}

function extractRatingValue(reply: string): number | null {
  const chineseMatch = reply.match(RATING_PATTERN);
  if (chineseMatch) {
    const numPart = chineseMatch[0].replace(/评分[：:]?\s*/, "");
    const val = parseFloat(numPart);
    if (!isNaN(val)) return val;
  }
  const allMatches = reply.match(DECIMAL_RATING);
  if (allMatches) {
    for (const m of allMatches) {
      const v = parseFloat(m);
      if (v >= 1.0 && v <= 10.0) return Math.round(v * 100) / 100;
    }
  }
  return null;
}
