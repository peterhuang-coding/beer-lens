import { NextResponse } from "next/server";
import { getMetricsSnapshot } from "@/lib/beer-agent/monitor/metrics";
import { composeMetrics } from "@/lib/beer-agent/monitor/metrics-composer";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Get live runtime snapshot (backward compat)
  const runtimeSnapshot = getMetricsSnapshot();

  // Compose BI metrics from data files (cases + metrics history)
  let biMetrics;
  try {
    biMetrics = await composeMetrics();
  } catch (err) {
    console.warn("[metrics/api] composeMetrics failed, returning runtime-only:", err);
    biMetrics = null;
  }

  return NextResponse.json({
    // BI metrics sections
    timestamp: biMetrics?.timestamp ?? runtimeSnapshot.timestamp,
    overview: biMetrics?.overview ?? emptyOverview(),
    funnel: biMetrics?.funnel ?? emptyFunnel(),
    quality: biMetrics?.quality ?? emptyQuality(),
    badcases: biMetrics?.badcases ?? emptyBadcases(),
    modelTools: biMetrics?.modelTools ?? emptyModelTools(),
    memory: biMetrics?.memory ?? emptyMemory(),
    memoryAB: biMetrics?.memoryAB ?? emptyMemoryAB(),
    planner: biMetrics?.planner ?? emptyPlanner(),
    eval: biMetrics?.eval ?? emptyEval(),

    // Legacy runtime fields (backward compat)
    counters: runtimeSnapshot.counters,
    intentDistribution: runtimeSnapshot.intentDistribution,
    intentSourceDistribution: runtimeSnapshot.intentSourceDistribution,
    handlerErrors: runtimeSnapshot.handlerErrors,
    windowSeconds: runtimeSnapshot.windowSeconds,
  });
}

// ── Empty-state fallbacks (stable structure, all zeros) ──

function emptyOverview() {
  return {
    turnCount: 0,
    imageTurnCount: 0,
    recommendationSuccessRate: 0,
    avgLatencyMs: 0,
    badcaseRate: 0,
    goodcaseRate: 0,
  };
}

function emptyFunnel() {
  return {
    imageUploaded: 0,
    ocrCandidatesExtracted: 0,
    beerDbLookupTotal: 0,
    beerDbHitRate: 0,
    recommendationGenerated: 0,
    followupTurns: 0,
    tastingFeedbackRecorded: 0,
  };
}

function emptyQuality() {
  return {
    ocrWrongCount: 0,
    intentWrongCount: 0,
    dataMissingCount: 0,
    recommendationBadCount: 0,
    hallucinationCount: 0,
    memoryWrongCount: 0,
    guardrailBlockRate: 0,
  };
}

function emptyBadcases() {
  return {
    tagDistribution: {} as Record<string, number>,
    intentDistribution: {} as Record<string, number>,
    badcaseByIntent: {} as Record<string, number>,
  };
}

function emptyModelTools() {
  return {
    modelCallCount: {} as Record<string, number>,
    modelErrorCount: 0,
    beerDbHitRate: 0,
    handlerErrorRate: {} as Record<string, number>,
    handlerErrorRateTotal: 0,
  };
}

function emptyMemory() {
  return {
    tastingEpisodeCount: 0,
    profileUpdateCount: 0,
    memoryUsedCount: 0,
    memoryCorrectionCount: 0,
    memoryEnabledTurns: 0,
    memoryDisabledTurns: 0,
    memoryUsedInScoringCount: 0,
    profileConfidenceAvg: 0,
  };
}

function emptyMemoryAB() {
  return {
    enabledFeedbackRate: 0,
    disabledFeedbackRate: 0,
    enabledRecBadRate: 0,
    disabledRecBadRate: 0,
    enabledMemoryWrongRate: 0,
    disabledMemoryWrongRate: 0,
    enabledCorrectionRate: 0,
    disabledCorrectionRate: 0,
  };
}

function emptyPlanner() {
  return {
    total: 0,
    success: 0,
    failed: 0,
    fallback: 0,
    avgSteps: 0,
    toolFailures: {} as Record<string, number>,
  };
}

function emptyEval() {
  return {
    testSetVersion: "unknown",
    latestRun: null,
    regressionTrend: { runs: [], passRateTrend: [], intentTrends: {}, rootCauseTrend: {} },
    intentPassRates: {} as Record<string, number>,
    rootCauseDist: {} as Record<string, number>,
    modelFailRates: {} as Record<string, number>,
    toolFailRates: {} as Record<string, number>,
    promptFailRates: {} as Record<string, number>,
  };
}
