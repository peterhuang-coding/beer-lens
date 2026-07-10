/**
 * Profile Tag Guess — generates proactive "guess what you'd like" questions
 * based on user's taste profile and long-term memory.
 *
 * Usage:
 *   const guess = await guessNextBeer(userId);
 *   // "你最近喜欢柑橘味的IPA，要不要试试带有热带水果风味的 Sour？"
 *
 * Rules:
 *  - Preferred style × adjacent popular styles
 *  - Preferred flavor tags × current menu matches
 *  - Unexplored style × high rating → encourage exploration
 */

import type { ProfileMemory } from "./profile";
import type { LongTermMemory } from "./long-term";
import { getProfileMemory } from "./profile";
import { getLongTermMemory } from "./long-term";

// ── Style adjacency map ──
// Maps liked styles to styles a drinker who likes X might also enjoy.
const STYLE_ADJACENCY: Record<string, string[]> = {
  ipa: ["hazy ipa", "session ipa", "west coast ipa", "pale ale", "neipa"],
  "hazy ipa": ["neipa", "ipa", "session ipa", "pale ale", "sour ipa"],
  lager: ["pilsner", "helles", "kolsch", "amber lager", "marzen"],
  pilsner: ["lager", "helles", "kolsch", "pale ale", "session ipa"],
  stout: ["porter", "imperial stout", "milk stout", "barleywine", "brown ale"],
  sour: ["gose", "berliner weisse", "sour ipa", "farmhouse ale", "saison"],
  wheat: ["hefeweizen", "witbier", "belgian blonde", "saison", "kolsch"],
  "pale ale": ["ipa", "session ipa", "amber ale", "hazy ipa", "pilsner"],
  saison: ["farmhouse ale", "sour", "belgian blonde", "witbier", "kolsch"],
  porter: ["stout", "brown ale", "baltic porter", "imperial stout", "mild ale"],
};

// ── Tag-to-style mapping ──
// Flavor tags that suggest adjacent styles
const TAG_STYLE_HINTS: Record<string, string[]> = {
  "柑橘": ["ipa", "hazy ipa", "session ipa", "pale ale"],
  "热带水果": ["hazy ipa", "neipa", "sour ipa", "sour"],
  "清爽": ["lager", "pilsner", "kolsch", "helles", "witbier"],
  "苦": ["ipa", "west coast ipa", "imperial stout", "esb"],
  "甜": ["milk stout", "belgian dubbel", "barleywine", "fruit beer"],
  "酸": ["sour", "gose", "berliner weisse", "sour ipa"],
  "咖啡": ["stout", "porter", "imperial stout", "brown ale"],
  "焦糖": ["amber ale", "brown ale", "scotch ale", "barleywine"],
};

export type GuessResult = {
  /** Short suggestion sentence */
  suggestion: string;
  /** The style being suggested */
  suggestedStyle: string;
  /** Why we think the user would like it */
  reason: string;
  /** Confidence in the guess (0-1) */
  confidence: number;
};

/**
 * Generate a "guess what you'd like" question based on the user's profile.
 * Returns null if there's not enough data to make a meaningful guess.
 */
export async function guessNextBeer(userId: string): Promise<GuessResult | null> {
  const profile = await getProfileMemory(userId).catch(() => null);
  const ltm = await getLongTermMemory(userId).catch(() => null);

  if (!profile) return null;

  // ── Strategy 1: Adjacent style to top preference ──
  // If the user likes a style, suggest an adjacent one they haven't tried
  if (profile.preferredStyles.length > 0) {
    const topStyles = profile.preferredStyles.slice(0, 3);
    const triedStyles = new Set([
      ...profile.preferredStyles.map(s => s.value.toLowerCase()),
      ...profile.dislikedStyles.map(s => s.value.toLowerCase()),
    ]);

    for (const ps of topStyles) {
      const styleLower = ps.value.toLowerCase();
      const adjacencies = findAdjacentStyles(styleLower);
      const unexplored = adjacencies.filter(s => !triedStyles.has(s));

      if (unexplored.length > 0) {
        const suggested = unexplored[0];
        const displayName = suggested.replace(/\b\w/g, c => c.toUpperCase());
        return {
          suggestion: `你很喜欢${ps.value}，要不要试试${displayName}？`,
          suggestedStyle: suggested,
          reason: `${ps.value}的爱好者也常喜欢${displayName}`,
          confidence: 0.8,
        };
      }
    }
  }

  // ── Strategy 2: Flavor tag hints ──
  if (profile.preferredTags.length > 0) {
    const topTags = profile.preferredTags.slice(0, 5);
    for (const tag of topTags) {
      const hintStyles = TAG_STYLE_HINTS[tag.value];
      if (hintStyles && hintStyles.length > 0) {
        const triedStylesSet = new Set(
          profile.preferredStyles.map(s => s.value.toLowerCase()),
        );
        const unexplored = hintStyles.filter(s => !triedStylesSet.has(s));
        if (unexplored.length > 0) {
          const suggested = unexplored[0];
          const displayName = suggested.replace(/\b\w/g, c => c.toUpperCase());
          return {
            suggestion: `你最近喜欢${tag.value}风味的啤酒，要不要试试${displayName}？`,
            suggestedStyle: suggested,
            reason: `${displayName}以${tag.value}风味著称`,
            confidence: 0.7,
          };
        }
      }
    }
  }

  // ── Strategy 3: Encourage rating pending beers ──
  if (ltm?.pendingFeedback && ltm.pendingFeedback.length > 0) {
    const pending = ltm.pendingFeedback[0];
    return {
      suggestion: `之前推荐了「${pending.beerName}」，喝了感觉怎么样？打个分告诉我吧！（1-5分）`,
      suggestedStyle: "",
      reason: "未评分记录：鼓励用户反馈",
      confidence: 0.6,
    };
  }

  return null;
}

/**
 * Find styles adjacent to the given style from the adjacncy map.
 * Does fuzzy matching on style keywords.
 */
function findAdjacentStyles(style: string): string[] {
  // Direct lookup
  for (const [key, adj] of Object.entries(STYLE_ADJACENCY)) {
    if (style.includes(key) || key.includes(style)) {
      return adj;
    }
  }

  // Broader matching
  for (const [key, adj] of Object.entries(STYLE_ADJACENCY)) {
    // Check if any word in the key appears in the style
    const keyWords = key.split(/\s+/);
    const styleWords = style.split(/\s+/);
    const overlap = keyWords.some(kw => styleWords.some(sw => sw.includes(kw) || kw.includes(sw)));
    if (overlap) return adj;
  }

  return [];
}
