import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BeerCandidate, JournalEntry } from "./types";

const JOURNAL_PATH = path.join(process.cwd(), "data", "beer_journal.json");
const CACHE_PATH = path.join(process.cwd(), "data", "last_recommendation.json");

// ── Journal ──

type JournalFile = { version: number; entries: TastingEntry[] };

export type TastingEntry = {
  id: string;
  createdAt: string;
  beerName: string;
  brewery: string;
  breweryCountry: string | null;
  style: string;
  abv: number;
  hops: string[];
  rating: number;           // 1-5
  wouldDrinkAgain: "yes" | "maybe" | "no";
  tasteTags: string[];
  aromaTags: string[];
  note: string;
};

export async function readJournal(): Promise<JournalFile> {
  try {
    const raw = await readFile(JOURNAL_PATH, "utf8");
    return JSON.parse(raw) as JournalFile;
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function writeJournal(entry: TastingEntry) {
  const journal = await readJournal();
  journal.entries.unshift(entry);
  await writeFile(JOURNAL_PATH, JSON.stringify(journal, null, 2) + "\n");
}

export async function getProfileStats(): Promise<string> {
  const journal = await readJournal();
  const entries = journal.entries;

  if (entries.length === 0) return "还没有品饮记录。";

  const lines: string[] = [];
  lines.push(`共 ${entries.length} 条记录。`);

  // Style preferences
  const styleCounts = countBy(entries, e => e.style);
  if (styleCounts.length) {
    lines.push(`偏好风格: ${styleCounts.slice(0, 5).map(s => `${s.key}(${s.count}次)`).join("、")}`);
  }

  // Country preferences
  const countryCounts = countBy(entries, e => e.breweryCountry ?? "未知");
  if (countryCounts.length) {
    lines.push(`偏好产地: ${countryCounts.slice(0, 5).map(s => `${s.key}(${s.count}次)`).join("、")}`);
  }

  // Hop preferences (from entries that have hops)
  const allHops = entries.flatMap(e => e.hops).filter(Boolean);
  const hopCounts = topN(allHops, 8);
  if (hopCounts.length) {
    lines.push(`偏好酒花: ${hopCounts.map(s => `${s.key}(${s.count}次)`).join("、")}`);
  }

  // ABV range
  const abvs = entries.map(e => e.abv).filter(a => a > 0);
  if (abvs.length) {
    lines.push(`ABV 舒适区: ${Math.min(...abvs).toFixed(1)}% - ${Math.max(...abvs).toFixed(1)}%`);
  }

  // Average rating
  const ratings = entries.map(e => e.rating).filter(r => r > 0);
  if (ratings.length) {
    const avg = (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1);
    lines.push(`平均评分: ${avg}/5`);
  }

  // High-rated beers
  const topBeers = entries.filter(e => e.rating >= 4).slice(0, 5);
  if (topBeers.length) {
    lines.push(`高分酒: ${topBeers.map(e => `${e.beerName}(${e.rating}/5)`).join("、")}`);
  }

  // Low-rated beers
  const lowBeers = entries.filter(e => e.rating <= 2).slice(0, 3);
  if (lowBeers.length) {
    lines.push(`低分酒: ${lowBeers.map(e => `${e.beerName}(${e.rating}/5)`).join("、")}`);
  }

  // Taste tag preferences
  const allTags = entries.flatMap(e => [...e.tasteTags, ...e.aromaTags]);
  const tagCounts = topN(allTags, 8);
  if (tagCounts.length) {
    lines.push(`风味偏好: ${tagCounts.map(s => `${s.key}(${s.count}次)`).join("、")}`);
  }

  return lines.join("\n");
}

// ── Last recommendation cache ──

export type CachedRecommendation = {
  candidates: Pick<BeerCandidate, "displayName" | "brewery" | "breweryCountry" | "style" | "abv" | "hops" | "untappdScore">[];
  timestamp: string;
};

export async function saveLastRecommendation(candidates: BeerCandidate[]) {
  const cached: CachedRecommendation = {
    candidates: candidates.slice(0, 20).map(c => ({
      displayName: c.displayName,
      brewery: c.brewery,
      breweryCountry: c.breweryCountry ?? null,
      style: c.style,
      abv: c.abv,
      hops: c.hops,
      untappdScore: c.untappdScore ?? null,
    })),
    timestamp: new Date().toISOString(),
  };
  await writeFile(CACHE_PATH, JSON.stringify(cached, null, 2) + "\n");
}

export async function getLastRecommendation(): Promise<CachedRecommendation | null> {
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    return JSON.parse(raw) as CachedRecommendation;
  } catch {
    return null;
  }
}

export function findBeerInCache(
  cache: CachedRecommendation | null,
  nameHint: string
): CachedRecommendation["candidates"][0] | null {
  if (!cache) return null;
  const hint = nameHint.toLowerCase();
  // Exact match
  let match = cache.candidates.find(c => c.displayName.toLowerCase() === hint);
  if (match) return match;
  // Partial match
  match = cache.candidates.find(c =>
    c.displayName.toLowerCase().includes(hint) || hint.includes(c.displayName.toLowerCase())
  );
  return match ?? null;
}

// ── Helpers ──

function countBy<T>(items: T[], fn: (item: T) => string): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = fn(item);
    if (key && key !== "Unknown style" && key !== "未知") {
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function topN(items: string[], n: number): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) {
    if (item) map.set(item, (map.get(item) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}
