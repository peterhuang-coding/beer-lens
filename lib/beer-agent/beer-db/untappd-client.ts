import { UntappdClient } from "untappd-node";
import type { SearchResult, Beer } from "untappd-node";

const client = new UntappdClient();

export type { SearchResult, Beer };

export async function searchBeer(query: string): Promise<SearchResult[]> {
  try {
    return await client.searchBeers(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[untappd] search failed for "${query}": ${message}`);
    return [];
  }
}

export async function getBeerInfo(id: string): Promise<Beer | null> {
  try {
    return await client.getBeer(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[untappd] getBeer failed for "${id}": ${message}`);
    return null;
  }
}
