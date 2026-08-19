/**
 * Stats — derive aggregate metrics from the trace ring buffer.
 *
 * All numbers are computed on demand from the in-memory buffer. There is
 * no persistent storage. This is intentionally cheap so the /debug
 * Stats tab can poll every 3 s without measurable CPU cost.
 *
 * Output shape (single object, JSON-serialisable):
 *   {
 *     rpm: number,                   // requests per minute (rolling)
 *     p50_latency_ms: number,
 *     p95_latency_ms: number,
 *     error_rate: number,            // 0..1
 *     skill_distribution: Array<{ skill_id, count }>,
 *     llm_distribution: Array<{ model, count, total_ms }>,
 *     rule_hits: Array<{ rule_id, count, last_fired_at }>,
 *     total_requests: number,
 *     window_minutes: number,
 *   }
 */

import { listTraceEntries, type TraceEntry } from "./trace-buffer.ts";
import { listRules } from "./rules.ts";

const WINDOW_MS = 5 * 60 * 1000; // last 5 minutes

export interface Stats {
  rpm: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  error_rate: number;
  skill_distribution: Array<{ skill_id: string; count: number }>;
  llm_distribution: Array<{ model: string; count: number; total_ms: number }>;
  rule_hits: Array<{ rule_id: string; count: number; last_fired_at: string | null }>;
  total_requests: number;
  window_minutes: number;
}

export function getStats(now: number = Date.now()): Stats {
  // Pull the full buffer (capped at MAX=500, plenty for 5-min window).
  const entries = listTraceEntries(500, { includeAll: true });
  const windowStart = now - WINDOW_MS;

  const roots = entries.filter((e) => e.parent_ts === null);
  const window = roots.filter((e) => e.ts >= windowStart);

  // RPM (requests per minute, rolling 5 min window).
  const minutes = WINDOW_MS / 60000;
  const rpm = window.length === 0 ? 0 : +(window.length / minutes).toFixed(1);

  // Latency p50 / p95.
  const latencies = window.map((e) => e.latency_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const p = (q: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(latencies.length - 1, Math.floor(q * latencies.length));
    return latencies[idx];
  };

  // Error rate (ok=false roots in window).
  const errorRate = window.length === 0 ? 0 : +(window.filter((e) => !e.ok).length / window.length).toFixed(3);

  // Skill distribution (root only).
  const skillCounts = new Map<string, number>();
  for (const e of window) {
    const k = e.skill_id || "none";
    skillCounts.set(k, (skillCounts.get(k) ?? 0) + 1);
  }
  const skill_distribution = [...skillCounts.entries()]
    .map(([skill_id, count]) => ({ skill_id, count }))
    .sort((a, b) => b.count - a.count);

  // LLM distribution — pull from llm:call descendants.
  const llmMap = new Map<string, { count: number; total_ms: number }>();
  for (const e of entries) {
    if (e.stage !== "llm:call") continue;
    const model = (e.decision as { model?: string } | undefined)?.model ?? "unknown";
    const cur = llmMap.get(model) ?? { count: 0, total_ms: 0 };
    cur.count += 1;
    cur.total_ms += e.duration_ms ?? 0;
    llmMap.set(model, cur);
  }
  const llm_distribution = [...llmMap.entries()]
    .map(([model, v]) => ({ model, count: v.count, total_ms: Math.round(v.total_ms) }))
    .sort((a, b) => b.count - a.count);

  // Rule hits — scan all rule:fire descendants.
  const ruleMap = new Map<string, { count: number; last_ts: number }>();
  for (const e of entries) {
    if (e.stage !== "rule:fire") continue;
    const ruleId = (e.decision as { rule_id?: string } | undefined)?.rule_id ?? "unknown";
    const cur = ruleMap.get(ruleId) ?? { count: 0, last_ts: 0 };
    cur.count += 1;
    if (e.ts > cur.last_ts) cur.last_ts = e.ts;
    ruleMap.set(ruleId, cur);
  }
  // Also seed every known rule so the Rules tab can show "0" hits for
  // never-fired rules.
  for (const r of listRules()) {
    if (!ruleMap.has(r.id)) ruleMap.set(r.id, { count: 0, last_ts: 0 });
  }
  const rule_hits = [...ruleMap.entries()]
    .map(([rule_id, v]) => ({
      rule_id,
      count: v.count,
      last_fired_at: v.last_ts > 0 ? new Date(v.last_ts).toISOString() : null,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    rpm,
    p50_latency_ms: p(0.5),
    p95_latency_ms: p(0.95),
    error_rate: errorRate,
    skill_distribution,
    llm_distribution,
    rule_hits,
    total_requests: roots.length,
    window_minutes: 5,
  };
}
