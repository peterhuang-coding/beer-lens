/**
 * always-on-crawler-lib.mjs — Pure helpers for always-on-crawler.
 *
 * Kept dependency-free and side-effect-free so tests/*.test.mts can import
 * without spawning child processes. The main script consumes these.
 */

export function dedupeAndMerge({ gaps = [], user = [], seeds = [] }, limit = 30) {
  const seen = new Set();
  const merged = [];
  function push(item) {
    const name = (item?.name || "").trim().toLowerCase();
    const brewery = (item?.brewery || "").trim().toLowerCase();
    if (!name || !brewery) return;
    const key = `${name}|${brewery}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  }
  for (const g of gaps) push(g);
  for (const u of user) push(u);
  for (const s of seeds) push(s);
  return merged.slice(0, Math.max(0, limit));
}

export function filterByBrewery(items, breweries) {
  if (!Array.isArray(breweries) || breweries.length === 0) return items;
  const needles = breweries.map((b) => b.toLowerCase());
  return items.filter((b) => {
    const lc = (b.brewery || "").toLowerCase();
    return needles.some((n) => lc.includes(n));
  });
}

export function filterByCountry(items, countries) {
  if (!Array.isArray(countries) || countries.length === 0) return items;
  const needles = countries.map((c) => c.toLowerCase());
  return items.filter((b) => {
    const lc = (b.country || "China").toLowerCase();
    return needles.some((n) => lc.includes(n));
  });
}

export function shapeOutput({ round, limit, filters, gaps, user, seeds, targets, generatedAt }) {
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    round: round ?? null,
    limit,
    filters: {
      breweries: filters?.breweries || [],
      countries: filters?.countries || [],
    },
    summary: {
      p0_gaps: gaps.length,
      p1_user: user.length,
      p2_seeds: seeds.length,
      total: targets.length,
    },
    targets,
  };
}