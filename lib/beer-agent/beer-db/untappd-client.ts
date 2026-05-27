import { openrouterFetch } from "../openrouter-client";

export type SearchResult = {
  id: string;
  name: string;
  brewery: string;
  style: string;
  abv: number;
  rating: number;
  url: string;
};

export type Beer = {
  id: string;
  name: string;
  brewery: string;
  style: string;
  abv: number;
  ibu: number | null;
  rating: number;
  numRatings: number;
  image: string | null;
  url: string;
};

const LOOKUP_MODEL = process.env.OPENROUTER_UNTAPPD_MODEL ?? "google/gemini-2.5-flash";

export async function searchBeer(query: string): Promise<SearchResult[]> {
  // Single beer: use same batch path with one item
  const results = await batchSearchBeers([query]);
  return results;
}

export async function getBeerInfo(id: string): Promise<Beer | null> {
  // Not used in batch flow, kept for API compatibility
  return null;
}

/**
 * Batch lookup — one LLM call for all beers.
 * Much faster and avoids rate limits.
 */
export async function batchSearchBeers(queries: string[]): Promise<SearchResult[]> {
  if (queries.length === 0) return [];

  const prompt = `For each beer below, look up its Untappd data. Return a JSON array with one object per beer, in the same order.

Beers:
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

For each beer return:
{
  "id": "numeric beer ID from Untappd",
  "name": "full beer name as on Untappd",
  "brewery": "brewery name",
  "style": "beer style",
  "abv": ABV as number,
  "rating": Untappd rating (0-5, number),
  "numRatings": total rating count (integer),
  "url": "https://untappd.com/b/..."
}

Use your knowledge of real Untappd data. If you truly don't know a beer, set all fields to "unknown" and rating to 0 — but try your best for well-known breweries.
Return ONLY a JSON array, no markdown.`;

  const raw = await callAi(prompt, 800 + queries.length * 200);
  const parsed = parseJson<any[]>(raw);

  if (!Array.isArray(parsed)) {
    console.warn(`[untappd-ai] batch lookup returned non-array: ${raw.slice(0, 200)}`);
    return [];
  }

  const results: SearchResult[] = parsed.map((item, i) => ({
    id: String(item.id ?? `ai_${i}`),
    name: String(item.name ?? queries[i] ?? "Unknown"),
    brewery: String(item.brewery ?? ""),
    style: String(item.style ?? ""),
    abv: Number(item.abv ?? 0),
    rating: Number(item.rating ?? 0),
    url: String(item.url ?? ""),
  }));

  console.log(`[untappd-ai] batch lookup ${queries.length} beers → ${results.filter(r => r.rating > 0).length} found`);
  return results;
}

async function callAi(prompt: string, maxTokens: number): Promise<string> {
  try {
    return await openrouterFetch({
      model: LOOKUP_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[untappd-ai] model error: ${msg}, retrying without json_object...`);
    return openrouterFetch({
      model: LOOKUP_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    });
  }
}

function parseJson<T>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch {}
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]) as T; } catch {}
  }
  throw new Error(`Cannot parse JSON from: ${raw.slice(0, 200)}`);
}
