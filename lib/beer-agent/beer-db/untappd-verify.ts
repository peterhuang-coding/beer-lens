/**
 * Untappd Rating Verification
 *
 * Uses web search to verify Untappd ratings from LLM lookups.
 * Backends: Brave Search API (free tier: 5K queries/month) or fallback.
 *
 * Cached verified ratings are stored in data/beer_cache.json with verified: true.
 */

type VerifiedRating = {
  untappdId: string | null;
  rating: number;
  ratingCount: number | null;
  untappdUrl: string | null;
  verified: true;
  verifiedAt: number;
};

/**
 * Search the web for a beer's real Untappd rating.
 * Returns null if no verified data found.
 */
export async function verifyUntappdRating(params: {
  beerName: string;
  brewery?: string;
}): Promise<VerifiedRating | null> {
  const { beerName, brewery } = params;

  // Try Brave Search API if configured
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey) {
    try {
      return await verifyViaBrave(beerName, brewery, braveKey);
    } catch (err) {
      console.warn(`[verify] Brave search failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // No search backend available
  return null;
}

// ── Brave Search API ──

async function verifyViaBrave(
  beerName: string,
  brewery: string | undefined,
  apiKey: string,
): Promise<VerifiedRating | null> {
  const query = brewery
    ? `site:untappd.com "${beerName}" "${brewery}"`
    : `site:untappd.com "${beerName}"`;

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;

  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!resp.ok) {
    throw new Error(`Brave API ${resp.status}`);
  }

  const data = (await resp.json()) as {
    web?: { results?: Array<{ url: string; title: string; description: string }> };
  };

  const results = data.web?.results ?? [];
  if (results.length === 0) return null;

  // Find the best Untappd result
  const untappdResult = results.find(
    (r) => r.url.includes("untappd.com/b/") && !r.url.includes("/photos") && !r.url.includes("/checkin"),
  );

  if (!untappdResult) return null;

  // Extract rating from title or description
  // Pattern: "Beer Name - Brewery - Untappd" with rating in description
  // Common patterns in search snippets: "Rating: 4.1", "4.10 out of 5", "Score: 4.10"
  const text = `${untappdResult.title} ${untappdResult.description}`;

  const rating = extractRating(text);
  const ratingCount = extractRatingCount(text);
  const id = extractUntappdId(untappdResult.url);

  if (rating === null) return null;

  return {
    untappdId: id,
    rating,
    ratingCount,
    untappdUrl: untappdResult.url,
    verified: true,
    verifiedAt: Date.now(),
  };
}

// ── Extraction helpers ──

function extractRating(text: string): number | null {
  // Match "4.10" or "4.1" near rating keywords
  const patterns = [
    /(?:rating|score|rated|avg)[:\s]*(\d\.\d{1,2})\b/i,
    /(\d\.\d{1,2})\s*(?:\/5|out of 5|⭐|★)/i,
    /(?:⭐|★)\s*(\d\.\d{1,2})\b/,
    /\b(\d\.\d{2})\b/, // Untappd always uses 2 decimal places
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const rating = parseFloat(m[1]);
      if (rating >= 1 && rating <= 5) return rating;
    }
  }

  return null;
}

function extractRatingCount(text: string): number | null {
  // Match patterns like "242,880 ratings", "173,852 check-ins"
  const m = text.match(/(\d{1,3}(?:,\d{3})*)\s*(?:ratings|check-ins|reviews|global ratings)/i);
  if (m) {
    return parseInt(m[1].replace(/,/g, ""), 10);
  }
  return null;
}

function extractUntappdId(url: string): string | null {
  // URL pattern: https://untappd.com/b/brewery/beer-name/123456
  const m = url.match(/untappd\.com\/b\/[^/]+\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Format the verification status for display.
 */
export function formatVerification(rating: number, verified: boolean): string {
  return verified ? `✅ ${rating.toFixed(2)} (已核实)` : `🤖 ${rating.toFixed(1)} (AI估算)`;
}
