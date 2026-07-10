import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getTastingEpisodes } from "./episodic";

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
};

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

  for (const ep of episodes) {
    const score = ep.feedback.overallScore;
    const wouldAgain = ep.feedback.wouldDrinkAgain;
    const style = ep.beer.style;

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
  const profile: ProfileMemory = {
    userId,
    updatedAt: new Date().toISOString(),
    summary,
    preferredStyles,
    dislikedStyles,
    preferredTags,
    dislikedTags,
    abvComfortRange,
    notes,
  };

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
    return JSON.parse(raw) as ProfileMemory;
  } catch {
    return rebuildProfileMemory(userId);
  }
}
