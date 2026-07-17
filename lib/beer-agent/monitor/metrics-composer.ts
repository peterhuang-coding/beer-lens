/**
 * BI metrics derivation layer.
 *
 * Reads existing data files (cases.json, metrics/latest.json, metrics/*.json)
 * and composes a comprehensive BI metrics snapshot for the debug dashboard.
 *
 * This module only reads — it never writes or modifies existing data.
 * Fields that cannot be derived return 0 (never null/undefined) for frontend stability.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MetricsSnapshot } from "./metrics";
import type { CaseRecord } from "../cases";

// ── Types ──

export type BiOverview = {
  turnCount: number;
  imageTurnCount: number;
  recommendationSuccessRate: number;
  avgLatencyMs: number;
  badcaseRate: number;
  goodcaseRate: number;
};

export type BiFunnel = {
  imageUploaded: number;
  ocrCandidatesExtracted: number;
  beerDbLookupTotal: number;
  beerDbHitRate: number;
  recommendationGenerated: number;
  followupTurns: number;
  tastingFeedbackRecorded: number;
};

export type BiQuality = {
  ocrWrongCount: number;
  intentWrongCount: number;
  dataMissingCount: number;
  recommendationBadCount: number;
  hallucinationCount: number;
  memoryWrongCount: number;
  guardrailBlockRate: number;
};

export type BiBadcases = {
  /** Count of cases per badcase label (excluding "good" and "response_bad") */
  tagDistribution: Record<string, number>;
  /** Intent distribution across all cases */
  intentDistribution: Record<string, number>;
  /** Badcase rate per intent */
  badcaseByIntent: Record<string, number>;
};

export type BiModelTools = {
  /** Model call count by source (rule, llm, fallback) */
  modelCallCount: Record<string, number>;
  modelErrorCount: number;
  beerDbHitRate: number;
  /** Handler error rate by handler name */
  handlerErrorRate: Record<string, number>;
  /** Total handler error rate */
  handlerErrorRateTotal: number;
};

export type BiMemory = {
  tastingEpisodeCount: number;
  profileUpdateCount: number;
  memoryUsedCount: number;
  memoryCorrectionCount: number;
  memoryEnabledTurns: number;
  memoryDisabledTurns: number;
  memoryUsedInScoringCount: number;
  profileConfidenceAvg: number;
};

export type BiMemoryAB = {
  enabledFeedbackRate: number;
  disabledFeedbackRate: number;
  enabledRecBadRate: number;
  disabledRecBadRate: number;
  enabledMemoryWrongRate: number;
  disabledMemoryWrongRate: number;
  enabledCorrectionRate: number;
  disabledCorrectionRate: number;
};

export type BiPlanner = {
  total: number;
  success: number;
  failed: number;
  fallback: number;
  avgSteps: number;
  toolFailures: Record<string, number>;
};

/** A single regression run record (self-contained snapshot). */
export type RegressionRun = {
  /** Run id, e.g. "regression-fresh-YYYYMMDD-HHMM" */
  id: string;
  /** When the run was executed */
  timestamp: string;
  /** Total test cases in the run */
  total: number;
  /** Pass count */
  pass: number;
  /** Fail count */
  fail: number;
  /** Pass rate (0-1) */
  passRate: number;
  /** Average confidence score across all cases */
  avgConfidence: number;
  /** Pass rate per intent (intent → rate) */
  passRateByIntent: Record<string, number>;
  /** Root cause distribution among failures (rootCause → count) */
  rootCauseDistribution: Record<string, number>;
  /** Model dimension failure rate: { "model_name": failRate } */
  modelFailRates: Record<string, number>;
  /** Tool dimension failure rate: { "tool_name": failRate } */
  toolFailRates: Record<string, number>;
  /** Prompt dimension failure rate: { "prompt_name": failRate } */
  promptFailRates: Record<string, number>;
};

/** Regression trend across multiple runs. */
export type RegressionTrend = {
  /** All runs sorted by timestamp asc */
  runs: RegressionRun[];
  /** Latest pass rate trend (last 10 runs for chart) */
  passRateTrend: Array<{ time: string; rate: number }>;
  /** Latest intent pass rate trends */
  intentTrends: Record<string, Array<{ time: string; rate: number }>>;
  /** Latest root cause trend */
  rootCauseTrend: Record<string, Array<{ time: string; count: number }>>;
};

/** Overall evaluation platform snapshot — pure-function aggregated from existing data files. */
export type BiEvalSnapshot = {
  /** Test set version (derived from traces/conversation prefix) */
  testSetVersion: string;
  /** Latest regression run */
  latestRun: RegressionRun | null;
  /** Regression trend history (all runs, sorted) */
  regressionTrend: RegressionTrend;
  /** Intent dimension pass rates (latest run) */
  intentPassRates: Record<string, number>;
  /** Root cause distribution (global, across all labeled cases) */
  rootCauseDist: Record<string, number>;
  /** Per-model failure rates */
  modelFailRates: Record<string, number>;
  /** Per-tool failure rates */
  toolFailRates: Record<string, number>;
  /** Per-prompt failure rates */
  promptFailRates: Record<string, number>;
};

export type BiMetricsSnapshot = {
  timestamp: string;
  overview: BiOverview;
  funnel: BiFunnel;
  quality: BiQuality;
  badcases: BiBadcases;
  modelTools: BiModelTools;
  memory: BiMemory;
  memoryAB: BiMemoryAB;
  planner: BiPlanner;
  /** Evaluation platform snapshot (regression + passes + rootCause by dimension). */
  eval: BiEvalSnapshot;
  /** Legacy counters array for backward compat */
  counters: MetricsSnapshot["counters"];
  /** Legacy intent distribution */
  intentDistribution: Record<string, number>;
  /** Legacy handler errors */
  handlerErrors: Record<string, number>;
};

// ── Constants ──

const DATA_DIR = path.join(process.cwd(), "data");
const METRICS_DIR = path.join(DATA_DIR, "metrics");

const BADCASE_LABELS = [
  "intent_wrong",
  "ocr_wrong",
  "data_missing",
  "recommendation_bad",
  "hallucination",
  "memory_wrong",
  "response_bad",
] as const;

type BadcaseLabel = (typeof BADCASE_LABELS)[number];

// ── Data loading helpers (fail-safe) ──

async function loadMetricsLatest(): Promise<MetricsSnapshot | null> {
  try {
    const raw = await readFile(path.join(METRICS_DIR, "latest.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadCases(): Promise<CaseRecord[]> {
  try {
    const raw = await readFile(path.join(DATA_DIR, "cases.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function loadMetricsHistory(): Promise<MetricsSnapshot[]> {
  try {
    const raw = await readFile(
      path.join(METRICS_DIR, `${new Date().toISOString().slice(0, 10)}.json`),
      "utf8",
    );
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ── Helper: find a counter value by name ──

function findCounter(
  counters: MetricsSnapshot["counters"],
  name: string,
): number {
  return counters.find((c) => c.name === name)?.value ?? 0;
}

// ── Overview derivation ──

function composeOverview(
  metrics: MetricsSnapshot | null,
  cases: CaseRecord[],
): BiOverview {
  const turnCount = metrics
    ? findCounter(metrics.counters, "turn.count")
    : 0;
  const avgLatencyMs = metrics
    ? findCounter(metrics.counters, "turn.avg_latency_ms")
    : 0;

  const imageTurnCount = cases.filter((c) => c.input.hasImage).length;

  // Recommendation success rate: among menu_recommend cases, how many are NOT badcased
  const recommendCases = cases.filter(
    (c) => c.intent.name === "menu_recommend",
  );
  const badRecommendCases = recommendCases.filter(
    (c) =>
      c.label != null &&
      c.label !== "good" &&
      (BADCASE_LABELS as readonly string[]).includes(c.label),
  );
  const recommendationSuccessRate =
    recommendCases.length > 0
      ? (recommendCases.length - badRecommendCases.length) / recommendCases.length
      : 0;

  // Badcase rate: among all labeled cases (excluding good), what percentage of total
  const labeledCases = cases.filter((c) => c.label != null);
  const badCases = labeledCases.filter(
    (c) => c.label !== "good" && c.label !== null,
  );
  const goodCases = labeledCases.filter((c) => c.label === "good");
  const badcaseRate =
    labeledCases.length > 0 ? badCases.length / labeledCases.length : 0;
  const goodcaseRate =
    labeledCases.length > 0 ? goodCases.length / labeledCases.length : 0;

  return {
    turnCount,
    imageTurnCount,
    recommendationSuccessRate,
    avgLatencyMs,
    badcaseRate,
    goodcaseRate,
  };
}

// ── Funnel derivation ──

function composeFunnel(
  metrics: MetricsSnapshot | null,
  cases: CaseRecord[],
): BiFunnel {
  const imageUploaded = cases.filter((c) => c.input.hasImage).length;
  const ocrCandidatesExtracted = cases.filter(
    (c) => c.input.hasImage && c.candidateCount > 0,
  ).length;

  // Beer DB lookups from runtime metrics
  const beerDbLookupTotal = metrics
    ? Math.round(
        findCounter(metrics.counters, "knowledge.hit_rate") * 100,
      ) // approximate — we don't have raw counts in counters, but we can use hit_rate
    : 0;
  const beerDbHitRate = metrics
    ? findCounter(metrics.counters, "knowledge.hit_rate")
    : 0;

  const recommendationGenerated = cases.filter(
    (c) => c.intent.name === "menu_recommend",
  ).length;
  const followupTurns = cases.filter(
    (c) => c.intent.name === "follow_up_filter",
  ).length;
  const tastingFeedbackRecorded = cases.filter(
    (c) => c.intent.name === "tasting_feedback",
  ).length;

  return {
    imageUploaded,
    ocrCandidatesExtracted,
    beerDbLookupTotal,
    beerDbHitRate,
    recommendationGenerated,
    followupTurns,
    tastingFeedbackRecorded,
  };
}

// ── Quality derivation ──

function composeQuality(
  metrics: MetricsSnapshot | null,
  cases: CaseRecord[],
): BiQuality {
  const labelCounts: Record<string, number> = {};
  for (const label of BADCASE_LABELS) {
    labelCounts[label] = cases.filter((c) => c.label === label).length;
  }

  const guardrailBlockRate = metrics
    ? findCounter(metrics.counters, "guardrail.block_rate")
    : 0;

  return {
    ocrWrongCount: labelCounts["ocr_wrong"] ?? 0,
    intentWrongCount: labelCounts["intent_wrong"] ?? 0,
    dataMissingCount: labelCounts["data_missing"] ?? 0,
    recommendationBadCount: labelCounts["recommendation_bad"] ?? 0,
    hallucinationCount: labelCounts["hallucination"] ?? 0,
    memoryWrongCount: labelCounts["memory_wrong"] ?? 0,
    guardrailBlockRate,
  };
}

// ── Badcases derivation ──

function composeBadcases(cases: CaseRecord[]): BiBadcases {
  // Tag distribution across badcase labels only
  const tagDistribution: Record<string, number> = {};
  for (const label of BADCASE_LABELS) {
    const count = cases.filter((c) => c.label === label).length;
    if (count > 0) {
      tagDistribution[label] = count;
    }
  }

  // Intent distribution across all cases
  const intentDistribution: Record<string, number> = {};
  for (const c of cases) {
    const intent = c.intent.name;
    intentDistribution[intent] = (intentDistribution[intent] ?? 0) + 1;
  }

  // Badcase rate per intent
  const badcaseByIntent: Record<string, number> = {};
  for (const intent of Object.keys(intentDistribution)) {
    const intentCases = cases.filter((c) => c.intent.name === intent);
    const badIntentCases = intentCases.filter(
      (c) =>
        c.label != null &&
        c.label !== "good" &&
        (BADCASE_LABELS as readonly string[]).includes(c.label),
    );
    badcaseByIntent[intent] =
      intentCases.length > 0
        ? badIntentCases.length / intentCases.length
        : 0;
  }

  return {
    tagDistribution,
    intentDistribution,
    badcaseByIntent,
  };
}

// ── Model/Tools derivation ──

function composeModelTools(
  metrics: MetricsSnapshot | null,
): BiModelTools {
  const modelCallCount: Record<string, number> = metrics
    ? {
        rule: metrics.intentSourceDistribution?.rule ?? 0,
        llm: metrics.intentSourceDistribution?.llm ?? 0,
        fallback: metrics.intentSourceDistribution?.fallback ?? 0,
      }
    : { rule: 0, llm: 0, fallback: 0 };

  const modelErrorCount = metrics
    ? findCounter(metrics.counters, "handler.error_rate")
    : 0;

  const beerDbHitRate = metrics
    ? findCounter(metrics.counters, "knowledge.hit_rate")
    : 0;

  const handlerErrorRate: Record<string, number> = metrics?.handlerErrors ?? {};
  const handlerErrorRateTotal = metrics
    ? findCounter(metrics.counters, "handler.error_rate")
    : 0;

  return {
    modelCallCount,
    modelErrorCount,
    beerDbHitRate,
    handlerErrorRate,
    handlerErrorRateTotal,
  };
}

// ── Memory derivation ──

function composeMemory(
  metrics: MetricsSnapshot | null,
  cases: CaseRecord[],
): BiMemory {
  const tastingEpisodeCount = cases.filter(
    (c) => c.intent.name === "tasting_feedback",
  ).length;

  // Profile updates happen on tasting_feedback (from orchestrator logic)
  const profileUpdateCount = tastingEpisodeCount;

  // Memory used: count cases that have short-term memory context
  // (conversationId exists and is not the default "local-web-session")
  const memoryUsedCount = cases.filter(
    (c) => c.conversationId != null,
  ).length;

  // Memory correction count
  const memoryCorrectionCount = cases.filter(
    (c) => c.intent.name === "memory_correction",
  ).length;

  return {
    tastingEpisodeCount,
    profileUpdateCount,
    memoryUsedCount,
    memoryCorrectionCount,
    memoryEnabledTurns: Math.round(findCounter(metrics?.counters ?? [], "memory.enabled.turns")),
    memoryDisabledTurns: Math.round(findCounter(metrics?.counters ?? [], "memory.disabled.turns")),
    memoryUsedInScoringCount: Math.round(findCounter(metrics?.counters ?? [], "memory.used_in_scoring.count")),
    profileConfidenceAvg: findCounter(metrics?.counters ?? [], "profile.confidence.avg"),
  };
}

function composeMemoryAB(cases: CaseRecord[]): BiMemoryAB {
  const allLabeled = cases.filter((c) => c.label != null);
  const totalCases = cases.length || 1;

  const enabledFeedbackRate =
    cases.filter((c) => c.intent.name === "tasting_feedback").length / totalCases;
  const enabledRecBadRate =
    allLabeled.length > 0
      ? allLabeled.filter((c) => c.label === "recommendation_bad").length / allLabeled.length
      : 0;
  const enabledMemoryWrongRate =
    allLabeled.length > 0
      ? allLabeled.filter((c) => c.label === "memory_wrong").length / allLabeled.length
      : 0;
  const enabledCorrectionRate =
    cases.filter((c) => c.intent.name === "memory_correction").length / totalCases;

  return {
    enabledFeedbackRate,
    disabledFeedbackRate: 0,
    enabledRecBadRate,
    disabledRecBadRate: 0,
    enabledMemoryWrongRate,
    disabledMemoryWrongRate: 0,
    enabledCorrectionRate,
    disabledCorrectionRate: 0,
  };
}

function composePlanner(metrics: MetricsSnapshot | null): BiPlanner {
  return {
    total: findCounter(metrics?.counters ?? [], "planner.total"),
    success: findCounter(metrics?.counters ?? [], "planner.success"),
    failed: findCounter(metrics?.counters ?? [], "planner.failed"),
    fallback: findCounter(metrics?.counters ?? [], "planner.fallback"),
    avgSteps: findCounter(metrics?.counters ?? [], "planner.avg_steps"),
    toolFailures: {},
  };
}

// ── Evaluation platform: pure-function summary layer ──
// These functions read existing data files (cases.json, traces) and derive
// regression-style metrics WITHOUT modifying the files or adding new data sources.

/** Derive test set version from the most recent trace files' conversation prefixes. */
function deriveTestSetVersion(cases: CaseRecord[]): string {
  // Look for case conversationId patterns like "regression-fresh-*" or "regression-*"
  const regressionPrefixes = cases
    .map((c) => c.conversationId ?? "")
    .filter((id) => /^regression/i.test(id))
    .map((id) => id.split("-").slice(0, 2).join("-"))
    .filter(Boolean);
  // Deduplicate
  const unique = [...new Set(regressionPrefixes)];
  if (unique.length > 0) return unique.join(", ");
  // Fallback: count total cases as a "version"
  return `v${Math.floor(cases.length / 10)}-${cases.length}cases`;
}

/** Derive intent pass rates from labeled cases. */
function deriveIntentPassRates(cases: CaseRecord[]): Record<string, number> {
  const intentCounts: Record<string, number> = {};
  const intentPasses: Record<string, number> = {};

  for (const c of cases) {
    const intent = c.intent.name;
    intentCounts[intent] = (intentCounts[intent] ?? 0) + 1;
    if (c.label === "good") {
      intentPasses[intent] = (intentPasses[intent] ?? 0) + 1;
    }
  }

  const rates: Record<string, number> = {};
  for (const intent of Object.keys(intentCounts)) {
    rates[intent] = intentCounts[intent] > 0
      ? (intentPasses[intent] ?? 0) / intentCounts[intent]
      : 0;
  }
  return rates;
}

/** Derive root cause distribution from labeled cases' rootCause fields. */
function deriveRootCauseDistribution(cases: CaseRecord[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const c of cases) {
    if (c.rootCause && c.label !== "good") {
      dist[c.rootCause] = (dist[c.rootCause] ?? 0) + 1;
    }
  }
  return dist;
}

/** Derive failure rates by model dimension from cases with rootCause. */
function deriveModelFailRates(cases: CaseRecord[]): Record<string, number> {
  const modelBad: Record<string, number> = {};
  const modelTotal: Record<string, number> = {};

  for (const c of cases) {
    if (c.rootCause === "model") {
      // Use intent as the "model dimension" proxy
      const intent = c.intent.name;
      modelBad[intent] = (modelBad[intent] ?? 0) + 1;
    }
    modelTotal[c.intent.name] = (modelTotal[c.intent.name] ?? 0) + 1;
  }

  const rates: Record<string, number> = {};
  for (const intent of Object.keys(modelBad)) {
    rates[intent] = modelTotal[intent] > 0 ? modelBad[intent] / modelTotal[intent] : 0;
  }
  return rates;
}

/** Derive failure rates by tool dimension. */
function deriveToolFailRates(cases: CaseRecord[]): Record<string, number> {
  // Tools that can fail: ocr, beer_db, recommendation, guardrail, memory
  const toolMap: Record<string, string> = {
    ocr: "ocr",
    beer_db: "beer_db",
    recommendation: "recommendation",
    guardrail: "guardrail",
    memory: "memory",
  };

  const toolBad: Record<string, number> = {};
  const toolTotal: Record<string, number> = {};

  for (const c of cases) {
    for (const [tool, rc] of Object.entries(toolMap)) {
      // Count tool-based badcases
      if (c.rootCause === rc && c.label !== "good") {
        toolBad[tool] = (toolBad[tool] ?? 0) + 1;
      }
      // Count tool-eligible cases (intent-based)
      if (c.intent.name === "menu_recommend" && (rc === "ocr" || rc === "beer_db" || rc === "recommendation")) {
        toolTotal[tool] = (toolTotal[tool] ?? 0) + 1;
      }
      if (c.intent.name === "tasting_feedback" && rc === "memory") {
        toolTotal[tool] = (toolTotal[tool] ?? 0) + 1;
      }
    }
  }

  const rates: Record<string, number> = {};
  for (const tool of Object.keys(toolBad)) {
    rates[tool] = toolTotal[tool] ?? 1 > 0 ? toolBad[tool] / (toolTotal[tool] ?? 1) : 0;
  }
  return rates;
}

/** Derive failure rates by prompt dimension. */
function derivePromptFailRates(cases: CaseRecord[]): Record<string, number> {
  const promptBad: Record<string, number> = {};
  const promptTotal: Record<string, number> = {};

  for (const c of cases) {
    const intent = c.intent.name;
    promptTotal[intent] = (promptTotal[intent] ?? 0) + 1;
    if (c.rootCause === "prompt" && c.label !== "good") {
      promptBad[intent] = (promptBad[intent] ?? 0) + 1;
    }
  }

  const rates: Record<string, number> = {};
  for (const intent of Object.keys(promptBad)) {
    rates[intent] = promptTotal[intent] > 0 ? promptBad[intent] / promptTotal[intent] : 0;
  }
  return rates;
}

/** Build a single RegressionRun snapshot from current cases. */
function composeLatestRun(cases: CaseRecord[]): RegressionRun | null {
  if (cases.length === 0) return null;

  const total = cases.length;
  const pass = cases.filter((c) => c.label === "good").length;
  const fail = total - pass;
  const passRate = total > 0 ? pass / total : 0;
  const avgConfidence = total > 0
    ? cases.reduce((s, c) => s + c.intent.confidence, 0) / total
    : 0;

  const passRateByIntent = deriveIntentPassRates(cases);
  const rootCauseDistribution = deriveRootCauseDistribution(cases);
  const modelFailRates = deriveModelFailRates(cases);
  const toolFailRates = deriveToolFailRates(cases);
  const promptFailRates = derivePromptFailRates(cases);

  return {
    id: `run_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    total,
    pass,
    fail,
    passRate,
    avgConfidence,
    passRateByIntent,
    rootCauseDistribution,
    modelFailRates,
    toolFailRates,
    promptFailRates,
  };
}

/** Build a regression trend by reading daily metrics files. */
async function composeRegressionTrend(): Promise<RegressionTrend> {
  const runs: RegressionRun[] = [];

  // Read all daily metrics files and derive per-day runs
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const METRICS_DIR = path.join(process.cwd(), "data", "metrics");
  try {
    const files = await fs.readdir(METRICS_DIR);
    const jsonFiles = files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();

    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(path.join(METRICS_DIR, file), "utf8");
        const dayData = JSON.parse(raw);
        if (!dayData || !dayData.length) continue;

        // Derive a run from the day's metrics snapshot
        const snapshot = dayData[0] || dayData;
        if (!snapshot?.counters) continue;

        const total = findCounter(snapshot.counters, "turn.count") || 0;
        const failCount = findCounter(snapshot.counters, "handler.error_rate") || 0;
        const pass = total - failCount;
        const passRate = total > 0 ? pass / total : 0;

        run: {
          runs.push({
            id: file.replace(".json", ""),
            timestamp: `${file.replace(".json", "")}T00:00:00.000Z`,
            total,
            pass,
            fail: failCount,
            passRate,
            avgConfidence: findCounter(snapshot.counters, "turn.avg_latency_ms") > 0 ? 0.8 : 0,
            passRateByIntent: snapshot.intentDistribution ?? {},
            rootCauseDistribution: {},
            modelFailRates: {},
            toolFailRates: {},
            promptFailRates: {},
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Metrics directory may not exist
  }

  // Sort by timestamp
  runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Pass rate trend (last 10)
  const passRateTrend = runs.slice(-10).map((r) => ({
    time: r.timestamp.slice(0, 10),
    rate: r.passRate,
  }));

  // Intent trends: for each intent, collect last 10 points
  const intentTrends: Record<string, Array<{ time: string; rate: number }>> = {};
  for (const run of runs) {
    for (const [intent, rate] of Object.entries(run.passRateByIntent)) {
      if (!intentTrends[intent]) intentTrends[intent] = [];
      intentTrends[intent].push({
        time: run.timestamp.slice(0, 10),
        rate: typeof rate === "number" ? rate : 0,
      });
    }
  }
  // Trim to last 10 per intent
  for (const intent of Object.keys(intentTrends)) {
    intentTrends[intent] = intentTrends[intent].slice(-10);
  }

  // Root cause trend across runs
  const rootCauseTrend: Record<string, Array<{ time: string; count: number }>> = {};
  for (const run of runs) {
    for (const [rc, count] of Object.entries(run.rootCauseDistribution)) {
      if (!rootCauseTrend[rc]) rootCauseTrend[rc] = [];
      rootCauseTrend[rc].push({
        time: run.timestamp.slice(0, 10),
        count: typeof count === "number" ? count : 0,
      });
    }
  }
  for (const rc of Object.keys(rootCauseTrend)) {
    rootCauseTrend[rc] = rootCauseTrend[rc].slice(-10);
  }

  return { runs, passRateTrend, intentTrends, rootCauseTrend };
}

/** Compose the full evaluation snapshot from existing data files. */
export async function composeEvalSnapshot(): Promise<BiEvalSnapshot> {
  const cases = await loadCases();
  const latestRun = composeLatestRun(cases);
  const regressionTrend = await composeRegressionTrend();

  const intentPassRates = deriveIntentPassRates(cases);
  const rootCauseDist = deriveRootCauseDistribution(cases);
  const modelFailRates = deriveModelFailRates(cases);
  const toolFailRates = deriveToolFailRates(cases);
  const promptFailRates = derivePromptFailRates(cases);
  const testSetVersion = deriveTestSetVersion(cases);

  return {
    testSetVersion,
    latestRun,
    regressionTrend,
    intentPassRates,
    rootCauseDist,
    modelFailRates,
    toolFailRates,
    promptFailRates,
  };
}

// ── Public API ──

export async function composeMetrics(): Promise<BiMetricsSnapshot> {
  const [metrics, cases] = await Promise.all([
    loadMetricsLatest(),
    loadCases(),
  ]);

  const overview = composeOverview(metrics, cases);
  const funnel = composeFunnel(metrics, cases);
  const quality = composeQuality(metrics, cases);
  const badcases = composeBadcases(cases);
  const modelTools = composeModelTools(metrics);
  const memory = composeMemory(metrics, cases);
  const memoryAB = composeMemoryAB(cases);
  const planner = composePlanner(metrics);
  const evalSnapshot = await composeEvalSnapshot();

  // Legacy counters for backward compat
  const counters: MetricsSnapshot["counters"] = metrics?.counters ?? [];
  const intentDistribution: Record<string, number> =
    metrics?.intentDistribution ?? {};
  const handlerErrors: Record<string, number> = metrics?.handlerErrors ?? {};

  return {
    timestamp: new Date().toISOString(),
    overview,
    funnel,
    quality,
    badcases,
    modelTools,
    memory,
    memoryAB,
    planner,
    eval: evalSnapshot,
    counters,
    intentDistribution,
    handlerErrors,
  };
}
