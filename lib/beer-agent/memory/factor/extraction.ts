/**
 * Factor Memory — 从对话中抽取结构化事实。
 *
 * 对应记忆系统 PRD：
 *   一、记忆抽取 → (一) Factor 抽取
 *
 * 流程：
 *   1. 数据分割：时间轴核密度分割（将密集对话切成"活动爆发"区间）
 *   2. Factor 抽取：大模型从每个区间提取 factor + keywords
 *   3. 格式校验 + 重复校验 + 数目截断
 *
 * 存储结构：
 *   data/memory/users/{userId}/factors.json
 *   [
 *     {
 *       id: "f_xxx",
 *       timeRange: ["2025-12-17T08:06:28Z", "2025-12-17T08:06:41Z"],
 *       factor: "12月18日是用户妈妈的生日。",
 *       keywords: ["妈妈", "生日"],
 *       vector: [0.1, 0.2, ...],  // embedding (optional, for retrieval)
 *       createdAt: "2025-12-17T10:00:00Z"
 *     }
 *   ]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type DialogTurn = {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
};

export type FactorRecord = {
  id: string;
  /** 对话时间区间 */
  timeRange: [string, string];
  /** 抽取的事实描述 */
  factor: string;
  /** 关键词 */
  keywords: string[];
  /** Embedding vector (for similarity search) */
  vector?: number[];
  /** 来源 traceId */
  sourceTraceId?: string;
  createdAt: string;
};

export type FactorExtractionOptions = {
  /** 最大分割区间数 */
  maxIntervals?: number;
  /** 最小分割区间数 */
  minIntervals?: number;
  /** 最大段落长度（字符数） */
  maxSegmentLength?: number;
  /** 最小段落长度（字符数） */
  minSegmentLength?: number;
  /** LLM 抽取 prompt（可覆盖默认） */
  extractionPrompt?: string;
};

// ═══════════════════════════════════════════════════════
// Data Segmentation — 时间轴核密度分割
// ═══════════════════════════════════════════════════════

/**
 * Segment dialog turns into "activity bursts" using timestamp gaps.
 * Simpler than full KDE: uses gap-based splitting.
 *
 * Algorithm:
 *   1. Sort turns by timestamp
 *   2. Calculate gaps between consecutive turns
 *   3. Find gaps > median_gap * 3 → split points
 *   4. Respect min/max segment length constraints
 */
export function segmentDialogTurns(
  turns: DialogTurn[],
  options: {
    maxIntervals?: number;
    minIntervals?: number;
    maxSegmentLength?: number;
    minSegmentLength?: number;
  } = {},
): DialogTurn[][] {
  const {
    maxIntervals = 10,
    minIntervals = 2,
    maxSegmentLength = 20000,
    minSegmentLength = 20,
  } = options;

  if (turns.length === 0) return [];

  // Sort by timestamp
  const sorted = [...turns].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Calculate total text length
  const totalLength = sorted.reduce((sum, t) => sum + t.content.length, 0);
  if (totalLength < minSegmentLength) return [sorted];

  // Calculate gaps between consecutive turns
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap =
      new Date(sorted[i].timestamp).getTime() -
      new Date(sorted[i - 1].timestamp).getTime();
    gaps.push(gap);
  }

  if (gaps.length === 0) return [sorted];

  // Median gap
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];

  // Split threshold: 3x median gap (valley detection)
  const splitThreshold = Math.max(medianGap * 3, 60_000); // at least 1 minute

  // Build segments
  const segments: DialogTurn[][] = [];
  let currentSegment: DialogTurn[] = [sorted[0]];
  let currentLength = sorted[0].content.length;

  for (let i = 1; i < sorted.length; i++) {
    const gap = gaps[i - 1];
    const turnLength = sorted[i].content.length;

    // Split if gap is large AND we won't violate min segment length
    if (gap > splitThreshold && currentLength >= minSegmentLength) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = [];
      currentLength = 0;
    }

    // Don't exceed max segment length
    if (currentLength + turnLength > maxSegmentLength && currentLength >= minSegmentLength) {
      segments.push(currentSegment);
      currentSegment = [];
      currentLength = 0;
    }

    currentSegment.push(sorted[i]);
    currentLength += turnLength;
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  // Enforce min/max intervals
  if (segments.length < minIntervals && segments.length >= 1) {
    return segments; // Return as-is if we can't split more
  }

  if (segments.length > maxIntervals) {
    // Merge smallest segments until we're under maxIntervals
    while (segments.length > maxIntervals) {
      let minIdx = 0;
      let minLen = Infinity;
      for (let i = 0; i < segments.length; i++) {
        const len = segments[i].reduce((s, t) => s + t.content.length, 0);
        if (len < minLen) { minLen = len; minIdx = i; }
      }
      // Merge with neighbor
      if (minIdx < segments.length - 1) {
        segments[minIdx] = [...segments[minIdx], ...segments[minIdx + 1]];
        segments.splice(minIdx + 1, 1);
      } else if (minIdx > 0) {
        segments[minIdx - 1] = [...segments[minIdx - 1], ...segments[minIdx]];
        segments.splice(minIdx, 1);
      }
    }
  }

  return segments;
}

// ═══════════════════════════════════════════════════════
// Factor Extraction — LLM-based
// ═══════════════════════════════════════════════════════

const DEFAULT_EXTRACTION_PROMPT = `你是信息抽取助手。从以下对话中提取关键事实（Factor）。

规则：
1. 每个事实用一句话描述，包含具体信息（时间、地点、人物、事件）
2. 每个事实附带 2-5 个关键词
3. 只提取对后续对话有用的事实（偏好、事件、关系、计划）
4. 不要提取闲聊、问候、无信息量的内容
5. 输出 JSON 数组格式

输出格式：
[{"factor": "用户计划明天早上8点起床", "keywords": ["闹钟", "早上8点"]}]`;

/**
 * Extract factors from a dialog segment using LLM.
 *
 * This function is a STUB — actual LLM call is delegated to the orchestrator.
 * The orchestrator should call this with the LLM response pre-parsed, or
 * this function can be extended to call openrouterFetch directly.
 */
export function parseFactorsFromLLMResponse(
  rawResponse: string,
  timeRange: [string, string],
  sourceTraceId?: string,
): FactorRecord[] {
  try {
    // Try direct JSON parse
    let parsed: Array<{ factor: string; keywords: string[] }>;
    try {
      parsed = JSON.parse(rawResponse.trim());
    } catch {
      // Try extracting JSON array from text
      const match = rawResponse.match(/\[[\s\S]*\]/);
      if (!match) return [];
      parsed = JSON.parse(match[0]);
    }

    if (!Array.isArray(parsed)) return [];

    const now = new Date().toISOString();
    return parsed.slice(0, 100).map((item, i) => ({
      id: `f_${Date.now()}_${i}`,
      timeRange,
      factor: item.factor || "",
      keywords: item.keywords || [],
      sourceTraceId,
      createdAt: now,
    }));
  } catch {
    return [];
  }
}

/**
 * Build the extraction prompt for LLM.
 */
export function buildExtractionPrompt(
  segment: DialogTurn[],
  customPrompt?: string,
): string {
  const basePrompt = customPrompt || DEFAULT_EXTRACTION_PROMPT;

  const dialogText = segment
    .map((t) => `[${t.timestamp}] ${t.role === "user" ? "用户" : "助手"}: ${t.content}`)
    .join("\n");

  const timeStart = segment[0]?.timestamp || "";
  const timeEnd = segment[segment.length - 1]?.timestamp || "";

  return `${basePrompt}

对话时间区间: ${timeStart} 至 ${timeEnd}

对话内容:
${dialogText}

请提取关键事实:`;
}

// ═══════════════════════════════════════════════════════
// Factor Storage
// ═══════════════════════════════════════════════════════

function factorFilePath(userId: string): string {
  return path.join(process.cwd(), "data", "memory", "users", userId, "factors.json");
}

/**
 * Read all factors for a user.
 */
export async function getFactors(userId: string): Promise<FactorRecord[]> {
  try {
    const raw = await readFile(factorFilePath(userId), "utf8");
    return JSON.parse(raw) as FactorRecord[];
  } catch {
    return [];
  }
}

/**
 * Append new factors for a user.
 */
export async function appendFactors(
  userId: string,
  factors: FactorRecord[],
): Promise<void> {
  const existing = await getFactors(userId);
  const all = [...existing, ...factors];

  // Dedup by factor text similarity (simple: exact match)
  const seen = new Set(existing.map((f) => f.factor));
  const newFactors = factors.filter((f) => !seen.has(f.factor));

  await mkdir(path.dirname(factorFilePath(userId)), { recursive: true });
  await writeFile(
    factorFilePath(userId),
    JSON.stringify([...existing, ...newFactors], null, 2) + "\n",
    "utf8",
  );
}

/**
 * Delete factors by ID.
 */
export async function deleteFactors(
  userId: string,
  factorIds: string[],
): Promise<void> {
  const existing = await getFactors(userId);
  const idSet = new Set(factorIds);
  const filtered = existing.filter((f) => !idSet.has(f.id));
  await writeFile(
    factorFilePath(userId),
    JSON.stringify(filtered, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Get factor count for a user.
 */
export async function getFactorCount(userId: string): Promise<number> {
  const factors = await getFactors(userId);
  return factors.length;
}
