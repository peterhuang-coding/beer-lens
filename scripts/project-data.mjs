/** Portable, read-only project data shared by the inspector and Skill Hub. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function readJson(file, fallback, root = ROOT) {
  try {
    return JSON.parse(await readFile(path.join(root, file), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function readBeers(root = ROOT) {
  const beers = await readJson(
    "data/chinese-craft-beers.json",
    undefined,
    root,
  );
  if (!Array.isArray(beers))
    throw new Error("Expected an array in data/chinese-craft-beers.json");
  return beers;
}
export async function getStats(root = ROOT) {
  const beers = await readBeers(root);
  const ratings = beers
    .map((b) => b.rating)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  // Seed scores are snapshots, not independently verified cache entries.
  return {
    source: "data/chinese-craft-beers.json",
    total_beers: beers.length,
    total_breweries: new Set(beers.map((b) => b.brewery).filter(Boolean)).size,
    avg_rating: ratings.length
      ? ratings.reduce((a, b) => a + b, 0) / ratings.length
      : null,
    verified_entries: 0,
    missing_abv: beers.filter((b) => b.abv == null).length,
    missing_rating: beers.filter((b) => b.rating == null).length,
  };
}
export async function getHealth(root = ROOT) {
  try {
    const stats = await getStats(root);
    return {
      healthy: stats.total_beers > 0,
      source: stats.source,
      seed_entries: stats.total_beers,
      verified_entries: 0,
    };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}
export async function getCrawlLog(root = ROOT) {
  let text;
  try {
    text = await readFile(path.join(root, "data/crawl-log.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((s) => s.trim())
    .map((s, index) => {
      try {
        return JSON.parse(s);
      } catch {
        throw new Error(`Invalid crawl-log JSON on line ${index + 1}`);
      }
    });
}
export async function getSnapshots(root = ROOT) {
  let files;
  try {
    files = await readdir(path.join(root, "data/snapshots"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const file of files
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-30)) {
    const data = await readJson(`data/snapshots/${file}`, undefined, root);
    const stats = data.stats ?? data;
    const date =
      data.date ??
      data.generatedAt?.slice(0, 10) ??
      file.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const total = stats.total_beers ?? stats.total;
    if (!date || !Number.isFinite(total) || total < 0)
      throw new Error(`Invalid snapshot: ${file}`);
    out.push({ date, total, verified: stats.verified_entries ?? null });
  }
  return out;
}
export async function getFeatures(root = ROOT) {
  let files;
  try {
    files = await readdir(path.join(root, "features"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    files
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map(async (file) => {
        const text = await readFile(path.join(root, "features", file), "utf8");
        return {
          id: file.replace(/\.md$/, ""),
          title: text.match(/^#\s+(.+)$/m)?.[1] ?? file,
          status: text.match(/^- Status:\s*(.+)$/im)?.[1] ?? "unknown",
        };
      }),
  );
}
export async function getApis(root = ROOT) {
  const pkg = await readJson("package.json", undefined, root);
  return {
    scripts: Object.entries(pkg.scripts ?? {}).map(([name, cmd]) => ({
      name,
      cmd,
    })),
    harnessCmds: [],
  };
}
