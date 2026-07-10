import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getTastingEpisodes } from "./episodic";
import { getCorrections, type CorrectionEntry } from "./corrections";

export type ProfileMemory = {
  userId: string;
  updatedAt: string;
  summary: string;
  preferredStyles: Array<{ value: string; weight: number; evidenceCount: number }>;
  dislikedStyles: Array<{ value: string; weight: number; evidenceCount: number }>;
  preferredTags: Array<{ value: string; weight: number; evidenceCount: number }>;
  dislikedTags: Array<{ value: string; weight: number; evidenceCount: number }>;
  abvComfortRange?: { min: number; max: number; evidenceCount: number };
  notes: string[];
  /** 0-1, how confident the profile is based on evidence count. min(evidenceCount/10, 1) */
  confidence: number;
  /** Total number of tasting episodes used to build this profile */
  evidenceCount: number;
  /** Number of user corrections applied to this profile */
  correctionsCount: number;
  /** Whether corrections were applied during last rebuild */
  correctionsApplied: boolean;
};

type WeightedItem = { value: string; weight: number; evidenceCount: number };

function normalizePreferenceValue(value: string): string {
  return value.trim().toLowerCase();
}

function removeMatching(items: WeightedItem[], targetValue: string): WeightedItem[] {
  const target = normalizePreferenceValue(targetValue);
  return items.filter((item) => {
    const value = normalizePreferenceValue(item.value);
    return value !== target && !value.includes(target) && !target.includes(value);
  });
}

function upsertPreference(items: WeightedItem[], targetValue: string, weight = 2): WeightedItem[] {
  const cleanValue = targetValue.trim();
  if (!cleanValue) return items;

  const target = normalizePreferenceValue(cleanValue);
  const next = [...items];
  const existing = next.find((item) => {
    const value = normalizePreferenceValue(item.value);
    return value === target || value.includes(target) || target.includes(value);
  });

  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
    existing.evidenceCount = Math.max(existing.evidenceCount, 1);
  } else {
    next.push({ value: cleanValue, weight, evidenceCount: 1 });
  }

  return next.sort((a, b) => b.weight - a.weight);
}

function applyCorrections(
  profile: ProfileMemory,
  corrections: CorrectionEntry[],
): ProfileMemory {
  let preferredStyles = [...profile.preferredStyles];
  let dislikedStyles = [...profile.dislikedStyles];
  let preferredTags = [...profile.preferredTags];
  let dislikedTags = [...profile.dislikedTags];
  let correctedCount = 0;

  for (const correction of corrections) {
    correctedCount++;
    switch (correction.action) {
      case "remove_preferred_style":
        preferredStyles = removeMatching(preferredStyles, correction.targetValue);
        break;
      case "remove_disliked_style":
        dislikedStyles = removeMatching(dislikedStyles, correction.targetValue);
        break;
      case "add_preferred_style":
        dislikedStyles = removeMatching(dislikedStyles, correction.targetValue);
        preferredStyles = upsertPreference(preferredStyles, correction.targetValue, 2);
        break;
      case "add_disliked_tag":
        preferredTags = removeMatching(preferredTags, correction.targetValue);
        dislikedTags = upsertPreference(dislikedTags, correction.targetValue, 2);
        break;
      case "remove_preferred_tag":
        preferredTags = removeMatching(preferredTags, correction.targetValue);
        break;
      case "remove_disliked_tag":
        dislikedTags = removeMatching(dislikedTags, correction.targetValue);
        preferredTags = upsertPreference(preferredTags, correction.targetValue, 1);
        break;
    }
  }

  const summaryParts: string[] = [];
  const topStyleNames = preferredStyles.slice(0, 3).map((s) => s.value);
  if (topStyleNames.length > 0) {
    summaryParts.push(`偏好 ${topStyleNames.join("、")}`);
  }
  if (profile.abvComfortRange) {
    summaryParts.push(`ABV ${profile.abvComfortRange.min}-${profile.abvComfortRange.max}%`);
  }
  const topTagNames = preferredTags.slice(0, 4).map((t) => t.value);
  if (topTagNames.length > 0) {
    summaryParts.push(`喜欢${topTagNames.join("和")}风味`);
  }

  return {
    ...profile,
    preferredStyles,
    dislikedStyles,
    preferredTags,
    dislikedTags,
    correctionsCount: correctedCount,
    correctionsApplied: correctedCount > 0,
    summary:
      summaryParts.length > 0
        ? summaryParts.join("，")
        : "暂无足够的品饮记录来生成口味画像。",
  };
}

/**
 * Rebuild the user's profile from all tasting episodes.
 *
 * Aggregation rules:
 *  - overallScore >= 4 AND wouldDrinkAgain = "yes" → strong boost
 *  - overallScore >= 3.5                  → mild boost
 *  - overallScore <= 2.5 OR wouldDrinkAgain = "no" → disliked
 *  - ABV comfort range: only episodes with score >= 3.5
 */
export async function rebuildProfileMemory(
  userId: string,
): Promise<ProfileMemory> {
  const episodes = await getTastingEpisodes(userId);

  // Accumulators
  const styleWeights = new Map<string, { weight: number; evidenceCount: number }>();
  const dislikedStyleWeights = new Map<string, { weight: number; evidenceCount: number }>();
  const tagWeights = new Map<string, { weight: number; evidenceCount: number }>();
  const dislikedTagWeights = new Map<string, { weight: number; evidenceCount: number }>();
  const abvScores: number[] = [];
  const notes: string[] = [];
  let validEvidenceCount = 0;

  for (const ep of episodes) {
    const score = ep.feedback.overallScore;
    const wouldAgain = ep.feedback.wouldDrinkAgain;
    const style = ep.beer.style;

    // Count episodes with meaningful feedback as evidence
    if (score != null || wouldAgain !== "maybe") {
      validEvidenceCount++;
    }

    // ── Style aggregation ──
    if (style) {
      if ((score != null && score >= 4 && wouldAgain === "yes") || (score == null && wouldAgain === "yes")) {
        // Strong boost
        const existing = styleWeights.get(style) ?? { weight: 0, evidenceCount: 0 };
        existing.weight += 3;
        existing.evidenceCount += 1;
        styleWeights.set(style, existing);
      } else if (score != null && score >= 3.5) {
        // Mild boost
        const existing = styleWeights.get(style) ?? { weight: 0, evidenceCount: 0 };
        existing.weight += 1;
        existing.evidenceCount += 1;
        styleWeights.set(style, existing);
      }

      if ((score != null && score <= 2.5) || wouldAgain === "no") {
        // Disliked
        const existing = dislikedStyleWeights.get(style) ?? { weight: 0, evidenceCount: 0 };
        existing.weight += 2;
        existing.evidenceCount += 1;
        dislikedStyleWeights.set(style, existing);
      }
    }

    // ── Tag aggregation (aroma + taste + context) ──
    const allFeedbackTags = [
      ...ep.feedback.aromaTags,
      ...ep.feedback.tasteTags,
      ...ep.feedback.contextTags,
    ];

    for (const tag of allFeedbackTags) {
      if ((score != null && score >= 4 && wouldAgain === "yes") || (score == null && wouldAgain === "yes")) {
        const existing = tagWeights.get(tag) ?? { weight: 0, evidenceCount: 0 };
        existing.weight += 1;
        existing.evidenceCount += 1;
        tagWeights.set(tag, existing);
      } else if (score != null && score >= 3.5) {
        const existing = tagWeights.get(tag) ?? { weight: 0, evidenceCount: 0 };
        existing.weight += 0.5;
        existing.evidenceCount += 1;
        tagWeights.set(tag, existing);
      }

      if ((score != null && score <= 2.5) || wouldAgain === "no") {
        const existing = dislikedTagWeights.get(tag) ?? { weight: 0, evidenceCount: 0 };
        existing.weight += 1;
        existing.evidenceCount += 1;
        dislikedTagWeights.set(tag, existing);
      }
    }

    // ── ABV comfort range (only count episodes with score >= 3.5 AND ABV > 0) ──
    if (score != null && score >= 3.5 && ep.beer.abv != null && ep.beer.abv > 0) {
      abvScores.push(ep.beer.abv);
    }

    if (ep.feedback.note) {
      notes.push(ep.feedback.note);
    }
  }

  // ── Sort by weight descending ──
  const sortByWeight = (
    a: { weight: number },
    b: { weight: number },
  ) => b.weight - a.weight;

  const preferredStyles = [...styleWeights.entries()]
    .map(([value, { weight, evidenceCount }]) => ({
      value,
      weight,
      evidenceCount,
    }))
    .sort(sortByWeight);

  const dislikedStyles = [...dislikedStyleWeights.entries()]
    .map(([value, { weight, evidenceCount }]) => ({
      value,
      weight,
      evidenceCount,
    }))
    .sort(sortByWeight);

  const preferredTags = [...tagWeights.entries()]
    .map(([value, { weight, evidenceCount }]) => ({
      value,
      weight,
      evidenceCount,
    }))
    .sort(sortByWeight);

  const dislikedTags = [...dislikedTagWeights.entries()]
    .map(([value, { weight, evidenceCount }]) => ({
      value,
      weight,
      evidenceCount,
    }))
    .sort(sortByWeight);

  // ── ABV comfort range ──
  let abvComfortRange: { min: number; max: number; evidenceCount: number } | undefined;
  if (abvScores.length > 0) {
    const min = Math.min(...abvScores);
    const max = Math.max(...abvScores);
    // Don't show ABV range if all values are 0 (no real ABV data)
    if (min > 0 || max > 0) {
      abvComfortRange = {
        min,
        max,
        evidenceCount: abvScores.length,
      };
    }
  }

  // ── Confidence: min(evidenceCount/10, 1) ──
  const confidence = Math.min(validEvidenceCount / 10, 1);

  // ── Generate a simple Chinese summary ──
  const summaryParts: string[] = [];

  const topStyleNames = preferredStyles.slice(0, 3).map((s) => s.value);
  if (topStyleNames.length > 0) {
    summaryParts.push(`偏好 ${topStyleNames.join("、")}`);
  }

  if (abvComfortRange) {
    summaryParts.push(`ABV ${abvComfortRange.min}-${abvComfortRange.max}%`);
  }

  const topTagNames = preferredTags.slice(0, 4).map((t) => t.value);
  if (topTagNames.length > 0) {
    summaryParts.push(`喜欢${topTagNames.join("和")}风味`);
  }

  const summary =
    summaryParts.length > 0
      ? summaryParts.join("，")
      : "暂无足够的品饮记录来生成口味画像。";

  // ── Assemble profile ──
  let profile: ProfileMemory = {
    userId,
    updatedAt: new Date().toISOString(),
    summary,
    preferredStyles,
    dislikedStyles,
    preferredTags,
    dislikedTags,
    abvComfortRange,
    notes,
    confidence,
    evidenceCount: validEvidenceCount,
    correctionsCount: 0,
    correctionsApplied: false,
  };

  const corrections = await getCorrections(userId).catch(() => null);
  if (corrections && corrections.corrections.length > 0) {
    profile = applyCorrections(profile, corrections.corrections);
  }

  // ── Persist to disk ──
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "profile.json",
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(profile, null, 2) + "\n", "utf8");

  return profile;
}

/**
 * Get the current profile memory for a user.
 * Returns the cached version if available, otherwise rebuilds from episodes.
 * Backward compatible: missing confidence/evidenceCount default to 0.
 */
export async function getProfileMemory(
  userId: string,
): Promise<ProfileMemory> {
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "profile.json",
  );
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProfileMemory>;
    // Backward compat: fill in missing fields
    return {
      userId: parsed.userId ?? userId,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      summary: parsed.summary ?? "",
      preferredStyles: parsed.preferredStyles ?? [],
      dislikedStyles: parsed.dislikedStyles ?? [],
      preferredTags: parsed.preferredTags ?? [],
      dislikedTags: parsed.dislikedTags ?? [],
      abvComfortRange: parsed.abvComfortRange,
      notes: parsed.notes ?? [],
      confidence: parsed.confidence ?? 0,
      evidenceCount: parsed.evidenceCount ?? 0,
      correctionsCount: parsed.correctionsCount ?? 0,
      correctionsApplied: parsed.correctionsApplied ?? false,
    };
  } catch {
    return rebuildProfileMemory(userId);
  }
}

// ═══════════════════════════════════════════════════════
// Trends — monthly aggregation
// ═══════════════════════════════════════════════════════

export type TrendMonth = {
  /** "2026-07" */
  month: string;
  episodeCount: number;
  topStyles: string[];
  topTags: string[];
  dislikedTags: string[];
  avgScore: number;
  abvRange: { min: number; max: number } | null;
};

export type TrendSummary = {
  userId: string;
  updatedAt: string;
  months: TrendMonth[];
};

/**
 * Rebuild monthly trends from all tasting episodes.
 * Aggregates episodes by month, computing top styles/tags/disliked/avgScore/abvRange.
 */
export async function rebuildTrends(userId: string): Promise<TrendSummary> {
  const episodes = await getTastingEpisodes(userId);

  // Group episodes by month
  const byMonth = new Map<string, typeof episodes>();

  for (const ep of episodes) {
    const month = ep.createdAt.slice(0, 7); // "2026-07"
    const bucket = byMonth.get(month) ?? [];
    bucket.push(ep);
    byMonth.set(month, bucket);
  }

  const months: TrendMonth[] = [];

  for (const [month, eps] of byMonth.entries()) {
    const styleCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const dislikedTagCounts = new Map<string, number>();
    const scores: number[] = [];
    const abvs: number[] = [];

    for (const ep of eps) {
      // Style
      if (ep.beer.style) {
        styleCounts.set(ep.beer.style, (styleCounts.get(ep.beer.style) ?? 0) + 1);
      }

      // Tags (liked)
      const allFeedbackTags = [
        ...ep.feedback.aromaTags,
        ...ep.feedback.tasteTags,
        ...ep.feedback.contextTags,
      ];

      const score = ep.feedback.overallScore;
      const wouldAgain = ep.feedback.wouldDrinkAgain;

      if ((score != null && score >= 3.5) || wouldAgain === "yes") {
        for (const tag of allFeedbackTags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Tags (disliked)
      if ((score != null && score <= 2.5) || wouldAgain === "no") {
        for (const tag of allFeedbackTags) {
          dislikedTagCounts.set(tag, (dislikedTagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Score
      if (score != null) {
        scores.push(score);
      }

      // ABV
      if (ep.beer.abv != null && ep.beer.abv > 0) {
        abvs.push(ep.beer.abv);
      }
    }

    const sortByCountDesc = (a: [string, number], b: [string, number]) => b[1] - a[1];

    const topStyles = [...styleCounts.entries()]
      .sort(sortByCountDesc)
      .slice(0, 3)
      .map(([s]) => s);

    const topTags = [...tagCounts.entries()]
      .sort(sortByCountDesc)
      .slice(0, 5)
      .map(([t]) => t);

    const dislikedTags = [...dislikedTagCounts.entries()]
      .sort(sortByCountDesc)
      .slice(0, 3)
      .map(([t]) => t);

    const avgScore =
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : 0;

    const abvRange: { min: number; max: number } | null =
      abvs.length > 0
        ? { min: Math.min(...abvs), max: Math.max(...abvs) }
        : null;

    months.push({
      month,
      episodeCount: eps.length,
      topStyles,
      topTags,
      dislikedTags,
      avgScore,
      abvRange,
    });
  }

  // Sort by month ascending
  months.sort((a, b) => a.month.localeCompare(b.month));

  const trends: TrendSummary = {
    userId,
    updatedAt: new Date().toISOString(),
    months,
  };

  // Persist to disk
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "trends.json",
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(trends, null, 2) + "\n", "utf8");

  return trends;
}

/**
 * Get trends for a user. Reads from disk, rebuilds if missing.
 * Backward compatible: missing file triggers rebuild.
 */
export async function getTrends(userId: string): Promise<TrendSummary> {
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "trends.json",
  );
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as TrendSummary;
  } catch {
    return rebuildTrends(userId);
  }
}
