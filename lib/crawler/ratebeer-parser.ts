/**
 * RateBeer HTML → BeerRecord parser. Pure functions; no I/O, no globals,
 * safe to import in tests with fixture HTML.
 */
import type { BeerRecord } from "./contracts.ts";
import {
  DETAIL_ABV_RE,
  DETAIL_BREWERY_RE,
  DETAIL_NAME_RE,
  DETAIL_RATING_COUNT_RE,
  DETAIL_RATING_RE,
  DETAIL_STYLE_RE,
  LIST_BEER_LINK_RE,
  RATEBEER_BASE,
  TAG_STRIP_RE,
  WS_COLLAPSE_RE,
} from "./ratebeer-selectors.ts";

/** Result of a list-page scan. */
export interface RatebeerListEntry {
  source_id: string;
  url: string;
  name: string;
  brewery_slug: string | null;
}

/** Clean a captured HTML string to plain text (HTML-strip + collapse ws). */
export function htmlToText(raw: string): string {
  return raw
    .replace(TAG_STRIP_RE, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(WS_COLLAPSE_RE, " ")
    .trim();
}

/** Convert a "1,234" string into 1234; returns null when unparseable. */
export function toIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned.length === 0) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

/** Convert a "4.5" string into 4.5; returns null when unparseable. */
export function toFloatOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.trim();
  if (cleaned.length === 0) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a rating into the 0-5 range, return null if out of band. */
export function clampRating(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 5) return null;
  return value;
}

/** Clamp ABV to a sane 0-25 range (anything beyond is a parsing bug). */
export function clampAbv(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 25) return null;
  return value;
}

/**
 * Walk a list page and pull out (source_id, url, name) tuples. The regex
 * is global; we iterate to avoid the "lastIndex" hazard that bites when
 * the same regex is shared between tests in the same VM.
 */
export function parseRatebeerList(html: string): RatebeerListEntry[] {
  const out: RatebeerListEntry[] = [];
  const re = new RegExp(LIST_BEER_LINK_RE.source, LIST_BEER_LINK_RE.flags);
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const slug = m[2];
    const id = m[3];
    const inner = m[4] ?? "";
    const name = htmlToText(inner);
    if (!name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      source_id: id,
      url: `${RATEBEER_BASE}${href}`,
      name,
      brewery_slug: slug,
    });
  }
  return out;
}

/**
 * Walk a detail page and pull out the fields the goal brief asked for:
 * rating / style / ABV / brewery / number-of-ratings. Returns a *partial*
 * record so the crawler layer can fill in url / fetched_at / source /
 * source_id without re-parsing.
 *
 * The returned `abv` and `rating` are normalised (number|null).
 */
export function parseRatebeerDetail(
  html: string,
  listEntry: RatebeerListEntry,
): Omit<BeerRecord, "source" | "source_id" | "url" | "fetched_at"> {
  // Name
  const nameMatch = html.match(DETAIL_NAME_RE);
  const name = nameMatch ? htmlToText(nameMatch[1] ?? "") : listEntry.name;

  // Rating (0-5)
  const ratingMatch = html.match(DETAIL_RATING_RE);
  const rating = clampRating(toFloatOrNull(ratingMatch?.[1]));

  // Rating count
  const countMatch = html.match(DETAIL_RATING_COUNT_RE);
  const rating_count = toIntOrNull(countMatch?.[1] ?? countMatch?.[2]);

  // ABV
  const abvMatch = html.match(DETAIL_ABV_RE);
  const abv = clampAbv(toFloatOrNull(abvMatch?.[1]));

  // Style
  const styleMatch = html.match(DETAIL_STYLE_RE);
  const style = styleMatch
    ? htmlToText(styleMatch[1] ?? styleMatch[2] ?? "")
    : null;

  // Brewery
  const breweryMatch = html.match(DETAIL_BREWERY_RE);
  const brewery_id = breweryMatch ? breweryMatch[2] ?? null : null;
  const breweryName = breweryMatch ? htmlToText(breweryMatch[3] ?? "") : null;

  return {
    name,
    brewery_id,
    style: style && style.length > 0 ? style : null,
    abv,
    ibu: null, // RateBeer public pages do not always expose IBU
    rating,
    rating_count,
    description: null,
    labels: breweryName ? [breweryName] : [],
    food_pairing: [],
    similar_ids: [],
  };
}
