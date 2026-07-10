/**
 * Factor Integration — 基于 DBSCAN 聚类 + LLM 合并的记忆整合。
 *
 * 对应记忆系统 PRD：
 *   三、Factor 整合
 *
 * 流程：
 *   1. 构建 n×n 相似度矩阵（向量相似度 + 关键词 Jaccard 距离）
 *   2. DBSCAN 聚类分组
 *   3. 组内 LLM 合并（长度控制，分组循环）
 *   4. 写入合并后的 factors，删除原始分散 factors
 */

import type { FactorRecord } from "./extraction";
import { getFactors, appendFactors, deleteFactors } from "./extraction";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type IntegrationOptions = {
  /** 向量相似度阈值（DBSCAN eps） */
  embeddingSimilarityThreshold?: number;
  /** 关键词 Jaccard 相似度阈值 */
  keywordsSimilarityThreshold?: number;
  /** 单组合并后 factor 文本最大长度 */
  groupMaxLength?: number;
  /** 向量维度（用于生成零向量 fallback） */
  vectorDim?: number;
};

export type IntegrationResult = {
  /** 整合后的 factors */
  mergedFactors: FactorRecord[];
  /** 被删除的原始 factor IDs */
  deletedIds: string[];
  /** 聚类分组信息 */
  groups: number[][];
  /** 孤立点（未合并的）索引 */
  isolated: number[];
};

// ═══════════════════════════════════════════════════════
// Similarity computation
// ═══════════════════════════════════════════════════════

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dim = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < dim; i++) {
    dot += (a[i] || 0) * (b[i] || 0);
    normA += (a[i] || 0) ** 2;
    normB += (b[i] || 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Jaccard similarity between two keyword sets.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map((k) => k.toLowerCase()));
  const setB = new Set(b.map((k) => k.toLowerCase()));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Combined similarity: weighted average of vector cosine + keyword Jaccard.
 * Weight: 0.8 embedding + 0.2 keyword (per PRD).
 */
function combinedSimilarity(
  a: FactorRecord,
  b: FactorRecord,
  embeddingWeight = 0.8,
): number {
  const vecSim = cosineSimilarity(a.vector || [], b.vector || []);
  const keySim = jaccardSimilarity(a.keywords, b.keywords);
  return embeddingWeight * vecSim + (1 - embeddingWeight) * keySim;
}

/**
 * Build n×n similarity matrix.
 */
function buildSimilarityMatrix(factors: FactorRecord[]): number[][] {
  const n = factors.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = combinedSimilarity(factors[i], factors[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
    matrix[i][i] = 1;
  }
  return matrix;
}

// ═══════════════════════════════════════════════════════
// DBSCAN clustering
// ═══════════════════════════════════════════════════════

/**
 * Simplified DBSCAN using similarity matrix.
 * - eps: minimum similarity to be considered "neighbors"
 * - minPts: minimum neighbors to form a cluster
 *
 * Returns: array of clusters (each cluster is an array of indices), and isolated indices.
 */
function dbscanClusters(
  similarityMatrix: number[][],
  eps: number,
  minPts: number = 2,
): { clusters: number[][]; isolated: number[] } {
  const n = similarityMatrix.length;
  const visited = new Set<number>();
  const noise = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    visited.add(i);

    // Find neighbors (points with similarity >= eps, excluding self)
    const neighbors: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i !== j && similarityMatrix[i][j] >= eps) {
        neighbors.push(j);
      }
    }

    if (neighbors.length < minPts) {
      noise.add(i);
      continue;
    }

    // Start a new cluster
    const cluster: number[] = [i];
    const queue = [...neighbors];

    while (queue.length > 0) {
      const q = queue.shift()!;
      if (visited.has(q)) {
        if (noise.has(q)) {
          noise.delete(q);
          cluster.push(q);
        }
        continue;
      }
      visited.add(q);

      const qNeighbors: number[] = [];
      for (let j = 0; j < n; j++) {
        if (q !== j && similarityMatrix[q][j] >= eps) {
          qNeighbors.push(j);
        }
      }

      if (qNeighbors.length >= minPts) {
        for (const nxt of qNeighbors) {
          if (!visited.has(nxt)) {
            queue.push(nxt);
          }
        }
      }

      cluster.push(q);
    }

    clusters.push(cluster);
  }

  return { clusters, isolated: [...noise] };
}

// ═══════════════════════════════════════════════════════
// Integration
// ═══════════════════════════════════════════════════════

/**
 * Integrate factors: cluster → merge within each cluster.
 *
 * This is a partial implementation. The LLM merge step requires a model call
 * which should be done by the orchestrator. This function does:
 *   1. Build similarity matrix
 *   2. DBSCAN clustering
 *   3. Identify groups to merge
 *
 * The orchestrator should then call mergeGroup() for each cluster.
 */
export function integrateFactors(
  factors: FactorRecord[],
  options: IntegrationOptions = {},
): {
  similarityMatrix: number[][];
  clusters: number[][];
  isolated: number[];
} {
  const {
    embeddingSimilarityThreshold = 0.95,
    keywordsSimilarityThreshold = 0.5,
  } = options;

  // Combined threshold: need both vector AND keyword similarity
  // Use max of the two to be more inclusive
  const eps = Math.max(embeddingSimilarityThreshold, keywordsSimilarityThreshold);

  const matrix = buildSimilarityMatrix(factors);
  const { clusters, isolated } = dbscanClusters(matrix, eps, 2);

  return { similarityMatrix: matrix, clusters, isolated };
}

/**
 * Merge a cluster of factors into one using simple concatenation.
 * For production, this should call an LLM.
 */
export function mergeClusterSimple(
  factors: FactorRecord[],
  clusterIndices: number[],
): FactorRecord {
  const cluster = clusterIndices.map((i) => factors[i]);
  const allKeywords = new Set<string>();
  let mergedFactor = "";
  let minTime = cluster[0].timeRange[0];
  let maxTime = cluster[0].timeRange[1];

  for (const f of cluster) {
    mergedFactor += (mergedFactor ? "；" : "") + f.factor;
    f.keywords.forEach((k) => allKeywords.add(k));
    if (f.timeRange[0] < minTime) minTime = f.timeRange[0];
    if (f.timeRange[1] > maxTime) maxTime = f.timeRange[1];
  }

  return {
    id: `f_merged_${Date.now()}`,
    timeRange: [minTime, maxTime],
    factor: mergedFactor,
    keywords: [...allKeywords],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build the LLM merge prompt for a cluster of factors.
 */
export function buildMergePrompt(
  factors: FactorRecord[],
  clusterIndices: number[],
): string {
  const cluster = clusterIndices.map((i) => factors[i]);
  const factorTexts = cluster
    .map((f, i) => `${i + 1}. ${f.factor} [关键词: ${f.keywords.join(", ")}]`)
    .join("\n");

  return `你是信息整合助手。将以下相关的事实合并为简洁的摘要。

规则：
1. 保留所有关键信息，去掉重复内容
2. 输出一个 JSON 对象：{"factor": "...", "keywords": ["..."]}
3. 关键词合并去重，保留 3-8 个最相关的

待整合事实:
${factorTexts}`;
}

/**
 * Full integration pipeline for a user.
 */
export async function runFactorIntegration(
  userId: string,
  options: IntegrationOptions = {},
): Promise<IntegrationResult> {
  const factors = await getFactors(userId);
  if (factors.length <= 1) {
    return { mergedFactors: [], deletedIds: [], groups: [], isolated: [0] };
  }

  const { clusters, isolated } = integrateFactors(factors, options);

  const mergedFactors: FactorRecord[] = [];
  const deletedIds: string[] = [];

  for (const cluster of clusters) {
    if (cluster.length <= 1) continue; // Skip singletons

    const merged = mergeClusterSimple(factors, cluster);
    mergedFactors.push(merged);

    // Collect IDs to delete
    for (const idx of cluster) {
      deletedIds.push(factors[idx].id);
    }
  }

  // Persist: append merged, delete originals
  if (mergedFactors.length > 0) {
    await appendFactors(userId, mergedFactors);
  }
  if (deletedIds.length > 0) {
    await deleteFactors(userId, deletedIds);
  }

  return {
    mergedFactors,
    deletedIds,
    groups: clusters,
    isolated,
  };
}
