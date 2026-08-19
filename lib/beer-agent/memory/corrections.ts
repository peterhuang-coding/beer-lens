import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { traceMemoryRead, traceMemoryWrite } from "./with-trace.ts";

// Simple in-process lock to prevent concurrent read-modify-write races
const writeLocks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

export type CorrectionAction =
  | "remove_preferred_style"
  | "remove_disliked_style"
  | "add_preferred_style"
  | "add_disliked_tag"
  | "remove_preferred_tag"
  | "remove_disliked_tag";

export type CorrectionEntry = {
  id: string;
  userId: string;
  createdAt: string;
  /** What kind of correction */
  action: CorrectionAction;
  /** The value being corrected (e.g., "IPA", "苦") */
  targetValue: string;
  /** The user's raw text that triggered this correction */
  sourceText: string;
};

export type CorrectionStore = {
  userId: string;
  updatedAt: string;
  corrections: CorrectionEntry[];
};

/**
 * Append a correction entry for a user.
 * Storage: data/memory/users/{userId}/corrections.json
 */
export async function appendCorrection(
  userId: string,
  entry: Omit<CorrectionEntry, "id" | "createdAt" | "userId">,
): Promise<void> {
  const dirPath = path.join(process.cwd(), "data", "memory", "users", userId);
  await mkdir(dirPath, { recursive: true });

  const filePath = path.join(dirPath, "corrections.json");

  await withLock(filePath, async () => {
    let store: CorrectionStore;
    try {
      const raw = await readFile(filePath, "utf8");
      store = JSON.parse(raw) as CorrectionStore;
    } catch {
      store = {
        userId,
        updatedAt: new Date().toISOString(),
        corrections: [],
      };
    }

    const fullEntry: CorrectionEntry = {
      id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      createdAt: new Date().toISOString(),
      ...entry,
    };

    store.corrections.push(fullEntry);
    store.updatedAt = new Date().toISOString();

    // Keep at most 50 corrections
    if (store.corrections.length > 50) {
      store.corrections = store.corrections.slice(-50);
    }

    try {
      await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
      traceMemoryWrite({
        kind: "correction",
        userId,
        action: entry.action,
        target_value_preview: entry.targetValue.slice(0, 40),
        total_corrections: store.corrections.length,
      });
    } catch (err) {
      traceMemoryWrite({
        kind: "correction",
        userId,
        action: entry.action,
        error: String((err as Error).message ?? err).slice(0, 200),
      }, false);
      throw err;
    }
  });
}

/**
 * Get all corrections for a user.
 * Returns empty store if file doesn't exist.
 */
export async function getCorrections(userId: string): Promise<CorrectionStore> {
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "corrections.json",
  );
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as CorrectionStore;
    traceMemoryRead({ kind: "correction", userId, count: parsed.corrections.length });
    return parsed;
  } catch {
    traceMemoryRead({ kind: "correction", userId, count: 0 });
    return {
      userId,
      updatedAt: new Date().toISOString(),
      corrections: [],
    };
  }
}

/**
 * Clear all corrections for a user.
 */
export async function clearCorrections(userId: string): Promise<void> {
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "corrections.json",
  );
  await withLock(filePath, async () => {
    const store: CorrectionStore = {
      userId,
      updatedAt: new Date().toISOString(),
      corrections: [],
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
  });
}

// ═══════════════════════════════════════════════════════
// Correction parsing (pure functions, no LLM)
// ═══════════════════════════════════════════════════════

export type ParsedCorrection = {
  action: CorrectionAction;
  targetValue: string;
};

/**
 * Parse user correction text into structured correction actions.
 * Uses regex patterns — no LLM dependency.
 */
export function parseCorrections(text: string): ParsedCorrection[] {
  const results: ParsedCorrection[] = [];
  const normalized = text.trim();

  // ── Rule 1: "我不是不喜欢X，我是不喜欢Y" → remove X from disliked, add Y to disliked ──
  // Also handles: "我不是不喜欢X，而是不喜欢Y", "我不是不喜欢X, 我是不喜欢Y"
  const notDislikeMatch = normalized.match(
    /我不是不喜欢(.+?)[，,、]*(?:而是|我是)不喜欢(.+)/,
  );
  if (notDislikeMatch) {
    const styleX = normalizeValue(notDislikeMatch[1]);
    const tagY = normalizeValue(notDislikeMatch[2]);
    if (styleX) {
      results.push({ action: "remove_disliked_style", targetValue: styleX });
    }
    if (tagY) {
      results.push({ action: "add_disliked_tag", targetValue: tagY });
    }
    if (results.length > 0) return results;
  }

  // ── Rule 2: "我其实喜欢X" → add X to preferred ──
  const actuallyLikeMatch = normalized.match(/我其实喜欢(.+)|其实.*喜欢(.+)/);
  if (actuallyLikeMatch) {
    const value = normalizeValue(actuallyLikeMatch[1] ?? actuallyLikeMatch[2]);
    if (value) {
      // Try to determine if it's a style or tag
      if (isLikelyStyle(value)) {
        results.push({ action: "add_preferred_style", targetValue: value });
      } else {
        results.push({ action: "remove_disliked_tag", targetValue: value });
        // Also boost this as a preferred preference
      }
    }
    if (results.length > 0) return results;
  }

  // ── Rule 3: "别再说我喜欢X" / "不要再说我喜欢X" → remove X from preferred ──
  const dontSayLikeMatch = normalized.match(
    /别(?:再)?说.*喜欢(.+)|不要.*说.*喜欢(.+)/,
  );
  if (dontSayLikeMatch) {
    const value = normalizeValue(dontSayLikeMatch[1] ?? dontSayLikeMatch[2]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "remove_preferred_style", targetValue: value });
      } else {
        results.push({ action: "remove_preferred_tag", targetValue: value });
      }
    }
    if (results.length > 0) return results;
  }

  // ── Rule 4: "我不喜欢X" (but not "我不是不喜欢") → add X to disliked ──
  const dislikeMatch = normalized.match(/我不喜欢(.+)/);
  if (dislikeMatch && !normalized.includes("我不是不喜欢")) {
    const value = normalizeValue(dislikeMatch[1]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "remove_preferred_style", targetValue: value });
      } else {
        results.push({ action: "add_disliked_tag", targetValue: value });
      }
    }
    if (results.length > 0) return results;
  }

  // ── Rule 5: "我喜欢X" (but not "其实喜欢" / "别说喜欢") → add X to preferred ──
  const likeMatch = normalized.match(/我喜欢(.+)/);
  if (
    likeMatch &&
    !normalized.includes("其实喜欢") &&
    !normalized.includes("别说") &&
    !normalized.includes("不要说")
  ) {
    const value = normalizeValue(likeMatch[1]);
    if (value) {
      if (isLikelyStyle(value)) {
        results.push({ action: "add_preferred_style", targetValue: value });
      } else {
        results.push({
          action: "remove_disliked_tag",
          targetValue: value,
        });
      }
    }
    if (results.length > 0) return results;
  }

  return results;
}

/** Clean up extracted value: trim, remove common particles */
function normalizeValue(raw: string): string {
  let cleaned = raw
    .trim()
    .replace(/[的了吗呢啊呀]+$/g, "")
    .replace(/^[的]+/g, "")
    .trim();

  // Remove trailing punctuation
  cleaned = cleaned.replace(/[。，,、；;！!？?]+$/g, "").trim();

  if (cleaned.length === 0) return "";
  return cleaned;
}

/** Heuristic: check if the value is likely a beer style rather than a flavor tag */
function isLikelyStyle(value: string): boolean {
  const styleKeywords = [
    "ipa",
    "拉格",
    "lager",
    "世涛",
    "stout",
    "酸啤",
    "sour",
    "小麦",
    "wheat",
    "皮尔森",
    "pilsner",
    "pils",
    "波特",
    "porter",
    "赛松",
    "saison",
    "大麦",
    "barleywine",
    "科隆",
    "kolsch",
    "helles",
    "博客",
    "bock",
    "amber",
    "棕艾",
    "brown ale",
    "session",
    "帝国",
    "imperial",
  ];
  const lower = value.toLowerCase();
  return styleKeywords.some((kw) => lower.includes(kw) || kw.includes(lower));
}

/** Human-readable description of a correction action */
export function describeCorrection(c: ParsedCorrection): string {
  switch (c.action) {
    case "remove_preferred_style":
      return `从"偏好风格"中移除「${c.targetValue}」`;
    case "remove_disliked_style":
      return `从"不喜欢的风格"中移除「${c.targetValue}」`;
    case "add_preferred_style":
      return `将「${c.targetValue}」加入"偏好风格"`;
    case "add_disliked_tag":
      return `将「${c.targetValue}」加入"不喜欢的风味"`;
    case "remove_preferred_tag":
      return `从"偏好风味"中移除「${c.targetValue}」`;
    case "remove_disliked_tag":
      return `从"不喜欢的风味"中移除「${c.targetValue}」`;
  }
}
