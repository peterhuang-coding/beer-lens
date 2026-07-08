/**
 * Side-channel monitoring module — collects operational metrics
 * without blocking the main dialog pipeline.
 *
 * Metrics collected:
 *  - turn latency (response time)
 *  - intent hit rate (rule vs llm vs fallback)
 *  - intent distribution
 *  - multi-intent rate
 *  - handler error rate
 *  - knowledge base hit rate (Beer DB found:true ratio)
 *  - guardrail block rate
 *  - transfer-to-human rate (consecutive unclear intents)
 *  - turn success rate
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// ── Metric types ──

export type MetricCounter = {
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
};

export type MetricsSnapshot = {
  timestamp: string;
  windowSeconds: number;
  counters: MetricCounter[];
  /** Per-intent breakdown */
  intentDistribution: Record<string, number>;
  /** Rule vs LLM vs Fallback hit counts */
  intentSourceDistribution: Record<string, number>;
  /** Handler error counts */
  handlerErrors: Record<string, number>;
};

// ── In-memory state ──

let _turnCount = 0;
let _totalLatencyMs = 0;
let _intentRuleCount = 0;
let _intentLlmCount = 0;
let _intentFallbackCount = 0;
let _multiIntentCount = 0;
let _guardrailBlockCount = 0;
let _handlerErrorCount = 0;
let _beerDbLookups = 0;
let _beerDbHits = 0;
let _successCount = 0;
let _unclearStreak = 0; // consecutive unclear intents
let _transferSuggestedCount = 0;

// Memory AB counters
let _memoryEnabledTurns = 0;
let _memoryDisabledTurns = 0;
let _memoryUsedInScoringCount = 0;
let _memoryCorrectionCount = 0;
let _profileConfidenceSum = 0;
let _profileConfidenceSamples = 0;
let _tastingEpisodeCount = 0;

// Planner-specific counters
let _plannerTotal = 0;
let _plannerSuccess = 0;
let _plannerFailed = 0;
let _plannerFallback = 0;
let _plannerTotalSteps = 0;
const _plannerToolFailures: Record<string, number> = {};

// Per-intent distribution
const _intentDist: Record<string, number> = {};
const _handlerErrors: Record<string, number> = {};

let _lastFlushTime = Date.now();
const METRICS_DIR = path.join(process.cwd(), "data", "metrics");
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds

// ── Recording functions (called from orchestrator) ──

export function recordTurnStart(): number {
  return Date.now();
}

export function recordTurnEnd(startMs: number, success: boolean): void {
  _turnCount++;
  _totalLatencyMs += Date.now() - startMs;
  if (success) _successCount++;
}

export function recordIntentResult(
  source: "rule" | "llm" | "fallback",
  intent: string,
  isMultiIntent: boolean,
): void {
  if (source === "rule") _intentRuleCount++;
  else if (source === "llm") _intentLlmCount++;
  else _intentFallbackCount++;

  _intentDist[intent] = (_intentDist[intent] ?? 0) + 1;
  if (isMultiIntent) _multiIntentCount++;
}

export function recordHandlerError(handlerName: string): void {
  _handlerErrorCount++;
  _handlerErrors[handlerName] = (_handlerErrors[handlerName] ?? 0) + 1;
}

export function recordBeerDbLookup(total: number, hits: number): void {
  _beerDbLookups += total;
  _beerDbHits += hits;
}

export function recordGuardrailBlock(): void {
  _guardrailBlockCount++;
}

/**
 * Track unclear intent streak. Returns true if transfer-to-human threshold reached.
 */
export function recordUnclearIntent(): boolean {
  _unclearStreak++;
  if (_unclearStreak >= 3) {
    _transferSuggestedCount++;
    return true;
  }
  return false;
}

export function resetUnclearStreak(): void {
  _unclearStreak = 0;
}

// ── Memory AB recording functions ──

export function recordMemoryReadEnabled(): void {
  _memoryEnabledTurns++;
}

export function recordMemoryReadDisabled(): void {
  _memoryDisabledTurns++;
}

export function recordMemoryUsedInScoring(): void {
  _memoryUsedInScoringCount++;
}

export function recordMemoryCorrection(): void {
  _memoryCorrectionCount++;
}

export function recordProfileConfidence(confidence: number): void {
  _profileConfidenceSum += confidence;
  _profileConfidenceSamples++;
}

export function recordTastingEpisode(): void {
  _tastingEpisodeCount++;
}

// ── Planner recording functions ──

export function recordPlannerStart(): void {
  _plannerTotal++;
}

export function recordPlannerEnd(
  success: boolean,
  stepCount: number,
  toolFailures: Record<string, number>,
): void {
  if (success) _plannerSuccess++;
  else _plannerFailed++;
  _plannerTotalSteps += stepCount;
  for (const [tool, count] of Object.entries(toolFailures)) {
    _plannerToolFailures[tool] = (_plannerToolFailures[tool] ?? 0) + count;
  }
}

export function recordPlannerFallback(): void {
  _plannerFallback++;
}

// ── Snapshot & persistence ──

export function getMetricsSnapshot(): MetricsSnapshot {
  const avgLatency = _turnCount > 0 ? Math.round(_totalLatencyMs / _turnCount) : 0;
  const totalIntents = _intentRuleCount + _intentLlmCount + _intentFallbackCount;

  const counters: MetricCounter[] = [
    { name: "turn.count", value: _turnCount, unit: "turns" },
    { name: "turn.avg_latency_ms", value: avgLatency, unit: "ms" },
    { name: "turn.success_rate", value: _turnCount > 0 ? _successCount / _turnCount : 1, unit: "ratio" },
    { name: "intent.hit_rate_rule", value: totalIntents > 0 ? _intentRuleCount / totalIntents : 0, unit: "ratio", tags: { source: "rule" } },
    { name: "intent.hit_rate_llm", value: totalIntents > 0 ? _intentLlmCount / totalIntents : 0, unit: "ratio", tags: { source: "llm" } },
    { name: "intent.hit_rate_fallback", value: totalIntents > 0 ? _intentFallbackCount / totalIntents : 0, unit: "ratio", tags: { source: "fallback" } },
    { name: "intent.multi_intent_rate", value: totalIntents > 0 ? _multiIntentCount / totalIntents : 0, unit: "ratio" },
    { name: "handler.error_rate", value: _turnCount > 0 ? _handlerErrorCount / _turnCount : 0, unit: "ratio" },
    { name: "knowledge.hit_rate", value: _beerDbLookups > 0 ? _beerDbHits / _beerDbLookups : 0, unit: "ratio" },
    { name: "guardrail.block_rate", value: _turnCount > 0 ? _guardrailBlockCount / _turnCount : 0, unit: "ratio" },
    { name: "transfer.human_suggestions", value: _transferSuggestedCount, unit: "count" },
    { name: "memory.enabled.turns", value: _memoryEnabledTurns, unit: "turns" },
    { name: "memory.disabled.turns", value: _memoryDisabledTurns, unit: "turns" },
    { name: "memory.used_in_scoring.count", value: _memoryUsedInScoringCount, unit: "count" },
    { name: "memory.correction.count", value: _memoryCorrectionCount, unit: "count" },
    { name: "profile.confidence.avg", value: _profileConfidenceSamples > 0 ? _profileConfidenceSum / _profileConfidenceSamples : 0, unit: "ratio" },
    { name: "tasting_episode.count", value: _tastingEpisodeCount, unit: "count" },
    { name: "planner.total", value: _plannerTotal, unit: "turns" },
    { name: "planner.success", value: _plannerSuccess, unit: "turns" },
    { name: "planner.failed", value: _plannerFailed, unit: "turns" },
    { name: "planner.fallback", value: _plannerFallback, unit: "turns" },
    { name: "planner.avg_steps", value: _plannerTotal > 0 ? Math.round(_plannerTotalSteps / _plannerTotal) : 0, unit: "steps" },
  ];

  return {
    timestamp: new Date().toISOString(),
    windowSeconds: Math.round((Date.now() - _lastFlushTime) / 1000),
    counters,
    intentDistribution: { ..._intentDist },
    intentSourceDistribution: { rule: _intentRuleCount, llm: _intentLlmCount, fallback: _intentFallbackCount },
    handlerErrors: { ..._handlerErrors },
  };
}

/**
 * Flush current metrics to disk (called periodically or on demand).
 * Uses a rotating file: data/metrics/latest.json + data/metrics/{yyyy-MM-dd}.json
 */
export async function flushMetrics(): Promise<void> {
  const snapshot = getMetricsSnapshot();

  try {
    await mkdir(METRICS_DIR, { recursive: true });
    await writeFile(
      path.join(METRICS_DIR, "latest.json"),
      JSON.stringify(snapshot, null, 2) + "\n",
      "utf8",
    );
    _lastFlushTime = Date.now();

    // Also append to daily log
    const dateStr = new Date().toISOString().slice(0, 10);
    const dailyPath = path.join(METRICS_DIR, `${dateStr}.json`);
    try {
      const existing = await readFile(dailyPath, "utf8");
      const history: MetricsSnapshot[] = JSON.parse(existing);
      history.push(snapshot);
      // Keep last 288 entries (24h at 5-min intervals)
      if (history.length > 288) history.shift();
      await writeFile(dailyPath, JSON.stringify(history, null, 2) + "\n", "utf8");
    } catch {
      await writeFile(dailyPath, JSON.stringify([snapshot], null, 2) + "\n", "utf8");
    }
  } catch (err) {
    console.warn("[metrics] flush failed:", err);
  }
}

// ── Periodic auto-flush ──

let _flushTimer: ReturnType<typeof setInterval> | null = null;

export function startMetricsFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    if (_turnCount > 0) {
      flushMetrics().catch(() => {});
    }
  }, FLUSH_INTERVAL_MS);
}

export function stopMetricsFlush(): void {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}
