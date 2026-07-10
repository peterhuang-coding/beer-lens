/**
 * Profile Reflection — 模型反思画像标签，double check 画像质量。
 *
 * 对应记忆系统 PRD：待优化项 1
 *   "抽完画像想加一个模型反思画像内容的环节，double check一波。
 *    检查复核当前画像标签内容标签是否有需要删减的，
 *    比如之前抽的不像是属于这个标签的，再次复核。"
 *
 * 流程：
 *   1. 读取当前用户画像
 *   2. 对每个标签，用 LLM 反思：这个标签是否合理？有没有应该删减的？
 *   3. 输出清理后的画像
 */

import type { ProfileMemory } from "./profile";
import { getProfileMemory, rebuildProfileMemory } from "./profile";
import { getTastingEpisodes } from "./episodic";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type ReflectionResult = {
  /** 原始标签数 */
  originalTagCount: number;
  /** 被标记为可疑的标签 */
  suspiciousTags: Array<{
    tagName: string;
    tagValue: string;
    reason: string;
    action: "keep" | "remove" | "modify";
    suggestedValue?: string;
  }>;
  /** 清理后的标签数 */
  cleanedTagCount: number;
  /** 反思时间 */
  reflectedAt: string;
};

// ═══════════════════════════════════════════════════════
// Reflection logic
// ═══════════════════════════════════════════════════════

/**
 * Build the reflection prompt for LLM.
 */
export function buildReflectionPrompt(profile: ProfileMemory): string {
  const styles = profile.preferredStyles
    .map((s) => `  - ${s.value} (权重: ${s.weight}, 证据: ${s.evidenceCount}条)`)
    .join("\n");

  const dislikedStyles = profile.dislikedStyles
    .map((s) => `  - ${s.value} (权重: ${s.weight}, 证据: ${s.evidenceCount}条)`)
    .join("\n");

  const tags = profile.preferredTags
    .map((t) => `  - ${t.value} (权重: ${t.weight}, 证据: ${t.evidenceCount}条)`)
    .join("\n");

  const dislikedTags = profile.dislikedTags
    .map((t) => `  - ${t.value} (权重: ${t.weight}, 证据: ${t.evidenceCount}条)`)
    .join("\n");

  const abvRange = profile.abvComfortRange
    ? `${profile.abvComfortRange.min}% - ${profile.abvComfortRange.max}% (${profile.abvComfortRange.evidenceCount}条)`
    : "暂无";

  return `你是用户画像质量审查员。复核以下啤酒口味画像标签，检查是否有不合理之处。

## 当前画像

偏好风格:
${styles || "  (无)"}

不喜欢的风格:
${dislikedStyles || "  (无)"}

偏好风味标签:
${tags || "  (无)"}

不喜欢的风味标签:
${dislikedTags || "  (无)"}

ABV 舒适区间: ${abvRange}

## 复核规则

1. 权重过低（<2）且证据不足（<2条）的标签 → 建议删除
2. 标签名称不像是啤酒风味描述的 → 建议删除
3. 标签之间有明显矛盾 → 标记可疑
4. 证据数量与权重不匹配 → 建议修正

输出 JSON:
{
  "suspiciousTags": [
    {"tagName": "preferredStyles", "tagValue": "xxx", "reason": "...", "action": "keep|remove|modify", "suggestedValue": "..."}
  ],
  "summary": "复核总结"
}`;
}

/**
 * Parse LLM reflection response.
 */
export function parseReflectionResponse(raw: string): {
  suspiciousTags: ReflectionResult["suspiciousTags"];
  summary: string;
} {
  try {
    const json = JSON.parse(raw.trim());
    return {
      suspiciousTags: json.suspiciousTags || [],
      summary: json.summary || "",
    };
  } catch {
    // Try extracting JSON block
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const json = JSON.parse(match[0]);
        return {
          suspiciousTags: json.suspiciousTags || [],
          summary: json.summary || "",
        };
      } catch {}
    }
    return { suspiciousTags: [], summary: raw };
  }
}

/**
 * Apply reflection results to clean up profile.
 * Removes tags marked as "remove", updates tags marked as "modify".
 * This is a LOCAL cleanup — the actual profile on disk is updated by rebuildProfileMemory.
 */
export function applyReflection(
  profile: ProfileMemory,
  reflection: { suspiciousTags: ReflectionResult["suspiciousTags"] },
): { cleanedProfile: ProfileMemory; changes: string[] } {
  const changes: string[] = [];
  const cleaned = JSON.parse(JSON.stringify(profile)) as ProfileMemory;

  for (const item of reflection.suspiciousTags) {
    if (item.action === "keep") continue;

    if (item.action === "remove") {
      if (item.tagName === "preferredStyles") {
        cleaned.preferredStyles = cleaned.preferredStyles.filter(
          (s) => s.value !== item.tagValue,
        );
        changes.push(`删除偏好风格: ${item.tagValue} — ${item.reason}`);
      } else if (item.tagName === "dislikedStyles") {
        cleaned.dislikedStyles = cleaned.dislikedStyles.filter(
          (s) => s.value !== item.tagValue,
        );
        changes.push(`删除不喜欢的风格: ${item.tagValue} — ${item.reason}`);
      } else if (item.tagName === "preferredTags") {
        cleaned.preferredTags = cleaned.preferredTags.filter(
          (t) => t.value !== item.tagValue,
        );
        changes.push(`删除偏好标签: ${item.tagValue} — ${item.reason}`);
      } else if (item.tagName === "dislikedTags") {
        cleaned.dislikedTags = cleaned.dislikedTags.filter(
          (t) => t.value !== item.tagValue,
        );
        changes.push(`删除不喜欢的标签: ${item.tagValue} — ${item.reason}`);
      }
    }

    if (item.action === "modify" && item.suggestedValue) {
      const updateTag = (arr: Array<{ value: string; weight: number; evidenceCount: number }>) => {
        const found = arr.find((s) => s.value === item.tagValue);
        if (found) {
          found.value = item.suggestedValue!;
          changes.push(`修正: ${item.tagValue} → ${item.suggestedValue} — ${item.reason}`);
        }
      };

      if (item.tagName === "preferredStyles") updateTag(cleaned.preferredStyles);
      else if (item.tagName === "dislikedStyles") updateTag(cleaned.dislikedStyles);
      else if (item.tagName === "preferredTags") updateTag(cleaned.preferredTags);
      else if (item.tagName === "dislikedTags") updateTag(cleaned.dislikedTags);
    }
  }

  return { cleanedProfile: cleaned, changes };
}

// ═══════════════════════════════════════════════════════
// Reflection log storage
// ═══════════════════════════════════════════════════════

const REFLECTION_LOG_DIR = path.join(process.cwd(), "data", "memory", "reflections");

/**
 * Save a reflection result to disk.
 */
export async function saveReflectionLog(
  userId: string,
  result: ReflectionResult,
): Promise<void> {
  await mkdir(REFLECTION_LOG_DIR, { recursive: true });
  const filePath = path.join(REFLECTION_LOG_DIR, `${userId}.json`);

  let history: ReflectionResult[] = [];
  try {
    const raw = await readFile(filePath, "utf8");
    history = JSON.parse(raw);
  } catch {}

  history.push(result);
  // Keep last 10 reflections
  if (history.length > 10) history = history.slice(-10);

  await writeFile(filePath, JSON.stringify(history, null, 2) + "\n", "utf8");
}

/**
 * Get reflection history for a user.
 */
export async function getReflectionHistory(userId: string): Promise<ReflectionResult[]> {
  try {
    const raw = await readFile(path.join(REFLECTION_LOG_DIR, `${userId}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
