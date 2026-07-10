/**
 * Long-term memory module — aggregates user preference trends over time.
 *
 * Builds on top of episodic memory (per-tasting records) and profile memory
 * (aggregated preferences). Adds:
 *
 *  - Frequent breweries/countries
 *  - ABV range evolution over time
 *  - Flavor tag frequency (word-cloud ready)
 *  - Recently drank beers without feedback → prompt user
 *  - Session context summaries (what the user typically asks about)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ProfileMemory } from "./profile";
import { getTastingEpisodes, type TastingEpisode } from "./episodic";

export type LongTermMemory = {
  userId: string;
  updatedAt: string;

  /** All-time favorites: brewery, country, style */
  favorites: {
    topBreweries: Array<{ name: string; count: number }>;
    topCountries: Array<{ name: string; count: number }>;
    topStyles: Array<{ name: string; count: number; avgRating: number }>;
  };

  /** ABV preference evolution (monthly buckets) */
  abvEvolution: Array<{
    month: string;
    avgAbv: number;
    count: number;
  }>;

  /** Most-referenced flavor tags across all feedback */
  flavorCloud: Array<{ tag: string; count: number; category: "aroma" | "taste" | "context" }>;

  /** Beers that were recommended but not yet rated */
  pendingFeedback: Array<{
    beerName: string;
    brewery: string;
    recommendedAt: string;
  }>;

  /** How many total sessions the user has had */
  totalEpisodes: number;
  totalSessions: number;

  /** Conversation topics the user frequently discusses */
  frequentIntents: Record<string, number>;
};

/**
 * Build or refresh long-term memory for a user.
 * Aggregates from all tasting episodes + profile memory.
 */
export async function buildLongTermMemory(
  userId: string,
): Promise<LongTermMemory> {
  const episodes = await getTastingEpisodes(userId);

  // ── Favorites aggregation ──
  const breweryCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const styleScores = new Map<string, { count: number; totalRating: number }>();
  const tagCounts = new Map<string, { count: number; category: "aroma" | "taste" | "context" }>();
  const abvByMonth = new Map<string, { totalAbv: number; count: number }>();
  const pending: LongTermMemory["pendingFeedback"] = [];

  for (const ep of episodes) {
    // Brewery
    if (ep.beer.brewery) {
      breweryCounts.set(ep.beer.brewery, (breweryCounts.get(ep.beer.brewery) ?? 0) + 1);
    }

    // Country (from beer object if available)
    const country = (ep.beer as any).breweryCountry as string | undefined;
    if (country) {
      countryCounts.set(country, (countryCounts.get(country) ?? 0) + 1);
    }

    // Style
    if (ep.beer.style) {
      const existing = styleScores.get(ep.beer.style) ?? { count: 0, totalRating: 0 };
      existing.count++;
      if (ep.feedback.overallScore != null) {
        existing.totalRating += ep.feedback.overallScore;
      }
      styleScores.set(ep.beer.style, existing);
    }

    // Tags
    for (const tag of ep.feedback.aromaTags) {
      const t = tagCounts.get(tag) ?? { count: 0, category: "aroma" as const };
      t.count++;
      tagCounts.set(tag, t);
    }
    for (const tag of ep.feedback.tasteTags) {
      const t = tagCounts.get(tag) ?? { count: 0, category: "taste" as const };
      t.count++;
      tagCounts.set(tag, t);
    }
    for (const tag of ep.feedback.contextTags) {
      const t = tagCounts.get(tag) ?? { count: 0, category: "context" as const };
      t.count++;
      tagCounts.set(tag, t);
    }

    // ABV by month
    if (ep.beer.abv != null && ep.beer.abv > 0) {
      const month = ep.createdAt.slice(0, 7); // "2026-07"
      const m = abvByMonth.get(month) ?? { totalAbv: 0, count: 0 };
      m.totalAbv += ep.beer.abv;
      m.count++;
      abvByMonth.set(month, m);
    }

    // Pending feedback: episodes without an overallScore
    if (ep.feedback.overallScore == null) {
      pending.push({
        beerName: ep.beer.displayName ?? "未知啤酒",
        brewery: ep.beer.brewery ?? "",
        recommendedAt: ep.createdAt,
      });
    }
  }

  // ── Sort helpers ──
  const sortByCount = (a: { count: number }, b: { count: number }) => b.count - a.count;

  const topBreweries = [...breweryCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(sortByCount)
    .slice(0, 10);

  const topCountries = [...countryCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(sortByCount)
    .slice(0, 10);

  const topStyles = [...styleScores.entries()]
    .map(([name, { count, totalRating }]) => ({
      name,
      count,
      avgRating: count > 0 ? Math.round((totalRating / count) * 10) / 10 : 0,
    }))
    .sort(sortByCount)
    .slice(0, 10);

  const flavorCloud = [...tagCounts.entries()]
    .map(([tag, { count, category }]) => ({ tag, count, category }))
    .sort(sortByCount);

  const abvEvolution = [...abvByMonth.entries()]
    .map(([month, { totalAbv, count }]) => ({
      month,
      avgAbv: count > 0 ? Math.round((totalAbv / count) * 10) / 10 : 0,
      count,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // ── Read intent distribution from profile notes ──
  const frequentIntents: Record<string, number> = {};
  // Simple: count by looking at episode context
  if (episodes.length > 0) {
    frequentIntents["tasting_feedback"] = episodes.filter(e => e.feedback.overallScore != null).length;
  }

  const memory: LongTermMemory = {
    userId,
    updatedAt: new Date().toISOString(),
    favorites: {
      topBreweries,
      topCountries,
      topStyles,
    },
    abvEvolution,
    flavorCloud,
    pendingFeedback: pending.slice(0, 10), // Keep at most 10
    totalEpisodes: episodes.length,
    totalSessions: 1, // Could be enhanced by counting unique sourceTraceIds
    frequentIntents,
  };

  // ── Persist ──
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "long-term.json",
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(memory, null, 2) + "\n", "utf8");

  return memory;
}

/**
 * Get long-term memory for a user, building if necessary.
 */
export async function getLongTermMemory(
  userId: string,
): Promise<LongTermMemory> {
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "long-term.json",
  );
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as LongTermMemory;
  } catch {
    return buildLongTermMemory(userId);
  }
}
