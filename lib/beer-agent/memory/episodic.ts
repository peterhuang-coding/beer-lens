import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { traceMemoryRead, traceMemoryWrite } from "./with-trace.ts";

// Simple in-process lock to prevent concurrent read-modify-write races
const writeLocks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

export type TastingEpisode = {
  id: string;
  userId: string;
  createdAt: string;
  sourceTraceId: string;
  beer: {
    displayName: string;
    brewery?: string;
    style?: string;
    abv?: number;
    untappdScore?: number | null;
  };
  feedback: {
    overallScore?: number;
    wouldDrinkAgain?: "yes" | "maybe" | "no";
    aromaTags: string[];
    tasteTags: string[];
    contextTags: string[];
    note?: string;
  };
  context?: {
    venue?: string;
    intentBeforeDrink?: string;
    recommendationPickType?: "top" | "safe" | "explore" | "avoid";
  };
};

/**
 * Append a new tasting episode for a user.
 * Storage: data/memory/users/{userId}/episodes.json
 * Uses an in-process lock to prevent concurrent read-modify-write races.
 */
export async function appendTastingEpisode(
  userId: string,
  episode: TastingEpisode,
): Promise<void> {
  const dirPath = path.join(process.cwd(), "data", "memory", "users", userId);
  await mkdir(dirPath, { recursive: true });

  const filePath = path.join(dirPath, "episodes.json");

  await withLock(filePath, async () => {
    let episodes: TastingEpisode[] = [];
    try {
      const raw = await readFile(filePath, "utf8");
      episodes = JSON.parse(raw) as TastingEpisode[];
    } catch {
      // File doesn't exist yet — start fresh
    }

    episodes.push(episode);
    try {
      await writeFile(filePath, JSON.stringify(episodes, null, 2) + "\n", "utf8");
      traceMemoryWrite({
        kind: "episodic",
        userId,
        beer_name: episode.beer.displayName,
        overall_score: episode.feedback.overallScore,
        episode_count: episodes.length,
      });
    } catch (err) {
      traceMemoryWrite({
        kind: "episodic",
        userId,
        beer_name: episode.beer.displayName,
        error: String((err as Error).message ?? err).slice(0, 200),
      }, false);
      throw err;
    }
  });
}

/**
 * Read all tasting episodes for a user.
 */
export async function getTastingEpisodes(
  userId: string,
): Promise<TastingEpisode[]> {
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "users",
    userId,
    "episodes.json",
  );
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as TastingEpisode[];
    traceMemoryRead({ kind: "episodic", userId, episode_count: parsed.length });
    return parsed;
  } catch {
    traceMemoryRead({ kind: "episodic", userId, episode_count: 0 });
    return [];
  }
}
