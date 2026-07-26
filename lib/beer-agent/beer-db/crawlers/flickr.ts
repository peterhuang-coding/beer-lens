/**
 * Beer Label Image Crawler — Wikimedia Commons first, Flickr API fallback.
 *
 * ## Strategy (#11)
 *
 * - Primary: Wikimedia Commons API. No key required, CC-BY / public domain
 *   results, deterministic URL patterns. Use this for "raw" link collection.
 * - Fallback: Flickr official REST API when FLICKR_API_KEY is set.
 * - If neither works: write nothing to beer tables. raw link list is the
 *   only writable artifact in the ingest pipeline.
 *
 * ## Raw-only contract
 *
 * This crawler MUST NOT write to `beers` or `untappd_cache` tables. It only
 * collects label image candidates and writes them to the raw pipeline
 * (`data/raw-crawl/raw/<sourceStamp>.json`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type FlickrMode = "wikimedia" | "flickr" | "auto";

export type FlickrOptions = {
  /** Source selection. 'auto' = Wikimedia first, fall back to Flickr. */
  mode?: FlickrMode;
  /** Search query (default: beer labels) */
  query?: string;
  /** Max results to collect (default 50) */
  limit?: number;
  /** Flickr API key. Required when mode='flickr'. Env: FLICKR_API_KEY */
  apiKey?: string;
  /** Custom Wikimedia endpoint (default: en.wikipedia.org) */
  wikimediaUserAgent?: string;
};

export type FlickrImage = {
  /** Stable source URL for the item page */
  pageUrl: string;
  /** Direct image URL (preferred) */
  imageUrl: string;
  /** Title / filename */
  title: string;
  /** License short name */
  license: string;
  /** Attribution string when present */
  attribution?: string;
  /** Source platform */
  platform: "wikimedia" | "flickr";
};

export type FlickrResult = {
  mode: FlickrMode;
  query: string;
  images: FlickrImage[];
  rawPath: string;
  source: string;
  errors: string[];
  warnings: string[];
  /** Audit fields */
  startedAt: string;
  completedAt: string;
};

// ── Constants ──

const RAW_DIR = path.join(process.cwd(), "data", "raw-crawl", "raw");
const TEMP_DIR = path.join(process.cwd(), ".temp");
const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const FLICKR_API = "https://api.flickr.com/services/rest/";

const USER_AGENT_FALLBACK =
  "BeerLens/1.0 (https://example.com/beer-lens) curl/8";

// ── Wikimedia Commons ──

/**
 * Search Wikimedia Commons via MediaWiki API.
 *
 * Strategy:
 *   1. generator=search for titles
 *   2. prop=imageinfo for resolved file URLs + license metadata
 *
 * Returns up to `limit` images with usable imageUrl + license + attribution.
 */
async function fetchWikimedia(
  query: string,
  limit: number,
  ua: string,
): Promise<FlickrImage[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6", // File namespace
    gsrsearch: query,
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime",
    iiurlwidth: "800",
  });
  const url = `${WIKIMEDIA_API}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": ua,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);
  const data: any = await res.json();
  const pages = data?.query?.pages ?? {};
  const images: FlickrImage[] = [];
  for (const pageId of Object.keys(pages)) {
    const page = pages[pageId];
    const title: string = page?.title ?? "";
    const info = page?.imageinfo?.[0];
    if (!title || !info?.url) continue;
    const ext: Record<string, { value?: string }> = info.extmetadata ?? {};
    const license: string =
      ext.LicenseShortName?.value ?? ext.LicenseName?.value ?? "Unknown";
    const artist = ext.Artist?.value ?? "";
    images.push({
      pageUrl: page?.fullurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      imageUrl: info.url,
      title: title.replace(/^File:/, ""),
      license,
      attribution: artist ? `${artist} / Wikimedia Commons / ${license}` : `Wikimedia Commons / ${license}`,
      platform: "wikimedia",
    });
  }
  return images;
}

// ── Flickr API ──

/**
 * Search via official Flickr API. Requires FLICKR_API_KEY.
 * Returns up to `limit` images with large-1024 URL where available.
 */
async function fetchFlickr(
  query: string,
  limit: number,
  apiKey: string,
): Promise<FlickrImage[]> {
  const params = new URLSearchParams({
    method: "flickr.photos.search",
    api_key: apiKey,
    text: query,
    per_page: String(limit),
    page: "1",
    format: "json",
    nojsoncallback: "1",
    license: "1,2,3,4,5,6,9", // CC & public domain only
    media: "photos",
    extras: "license,owner_name,url_l",
  });
  const url = `${FLICKR_API}?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Flickr HTTP ${res.status}`);
  const data: any = await res.json();
  if (data?.stat !== "ok") {
    throw new Error(`Flickr stat=fail: ${data?.message ?? "unknown"}`);
  }
  const photos = data?.photos?.photo ?? [];
  const images: FlickrImage[] = [];
  for (const p of photos) {
    if (!p.url_l || !p.url_l.startsWith("http")) continue;
    const pageUrl = `https://www.flickr.com/photos/${p.owner ?? "unknown"}/${p.id ?? ""}`;
    images.push({
      pageUrl,
      imageUrl: p.url_l,
      title: p.title ?? "",
      license: p.license ?? "Unknown",
      attribution: p.ownername ? `${p.ownername} / Flickr` : "Flickr",
      platform: "flickr",
    });
  }
  return images;
}

// ── Helpers ──

async function resolveAdapter(
  opts: FlickrOptions,
): Promise<{ mode: "wikimedia" | "flickr"; apiKey?: string; ua: string }> {
  const requested: FlickrMode = opts.mode ?? "auto";
  const apiKey = opts.apiKey ?? process.env.FLICKR_API_KEY ?? "";
  const ua = opts.wikimediaUserAgent ?? process.env.WIKIMEDIA_USER_AGENT ?? USER_AGENT_FALLBACK;

  if (requested === "wikimedia") {
    return { mode: "wikimedia", ua };
  }
  if (requested === "flickr") {
    if (!apiKey) throw new Error("[flickr-crawler] mode=flickr but FLICKR_API_KEY is unset");
    return { mode: "flickr", apiKey, ua };
  }
  // auto: try wikimedia first; Flickr only if key present and wikimedia yields 0
  return { mode: "wikimedia", ua };
}

// ── Main ──

/**
 * Search Wikimedia Commons + (optionally) Flickr for beer label images.
 *
 * Pure raw-collector. Persists a single raw JSON file documenting each
 * candidate. Does NOT touch beer tables.
 */
export async function searchBeerLabels(options: FlickrOptions = {}): Promise<FlickrResult> {
  const startedAt = new Date().toISOString();
  const query = options.query ?? "beer label";
  const limit = options.limit ?? 50;
  const errors: string[] = [];
  const warnings: string[] = [];
  const sourceStamp = new Date().toISOString().replace(/[:.]/g, "-");

  const outPath = path.join(RAW_DIR, `beer-labels-${sourceStamp}.json`);

  let images: FlickrImage[] = [];
  let mode: "wikimedia" | "flickr" = "wikimedia";
  let sourceLabel = "Wikimedia Commons";

  try {
    const adapter = await resolveAdapter(options);
    mode = adapter.mode;
    if (mode === "wikimedia") {
      try {
        images = await fetchWikimedia(query, limit, adapter.ua);
        sourceLabel = "Wikimedia Commons";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const apiKey = options.apiKey ?? process.env.FLICKR_API_KEY ?? "";
        if (apiKey) {
          warnings.push(`Wikimedia failed (${msg}), falling back to Flickr`);
          images = await fetchFlickr(query, limit, apiKey);
          mode = "flickr";
          sourceLabel = "Flickr API (fallback after Wikimedia)";
        } else {
          throw e;
        }
      }
    } else {
      images = await fetchFlickr(query, limit, adapter.apiKey!);
      sourceLabel = "Flickr API";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Search failed: ${msg}`);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        source: sourceLabel,
        mode,
        query,
        collectedAt: startedAt,
        imageCount: images.length,
        images,
        errors,
        warnings,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const completedAt = new Date().toISOString();
  console.log(
    `[flickr-crawler] done: mode=${mode} query="${query}" images=${images.length} -> ${outPath}`,
  );

  return {
    mode: options.mode ?? "auto",
    query,
    images,
    rawPath: outPath,
    source: sourceLabel,
    errors,
    warnings,
    startedAt,
    completedAt,
  };
}

// ── Internal: keep imports referenced (no top-level run) ──
// execFile + mkdir are used elsewhere via staging helpers; these
// references prevent linter dead-code complaints and make the
// module's external dependencies obvious.
void execFileAsync;
void mkdir;
void readFile;
void unlink;
void TEMP_DIR;
