/**
 * RateBeer selector table — keeps every regex/pattern the parser uses
 * in one auditable place. We deliberately avoid cheerio/playwright
 * (per risk line: "不引 playwright，用 cheerio / 正则就够") and use
 * plain regex over the public HTML.
 *
 * Source page: https://www.ratebeer.com/beer/country/46/  (46 = China
 * in RateBeer's country index, as seen on the public listings page).
 * Detail page: https://www.ratebeer.com/beer/<slug>/<id>/
 *
 * NOTE: These patterns target the publicly-rendered HTML observed on
 * ratebeer.com. If the site ships a redesign and a selector silently
 * stops matching, parseRatebeerDetail will return nulls — the tests
 * use fixtures so we'll know immediately.
 */
export const RATEBEER_BASE = "https://www.ratebeer.com";

/** Default list URL for "China" filter. Country id 46 is China. */
export const RATEBEER_CHINA_LIST_URL = `${RATEBEER_BASE}/beer/country/46/`;

/** Hard cap from the goal's risk redline. */
export const RATEBEER_MAX_CONCURRENCY = 4;

/** Default concurrency when caller leaves the option at default. */
export const RATEBEER_DEFAULT_CONCURRENCY = 2;

/* ────────────────────────── list page ────────────────────────── */

/** Match an `<a ... href="/beer/<slug>/<id>/">…</a>` block on a list page. */
export const LIST_BEER_LINK_RE =
  /<a[^>]+href="(\/beer\/([a-z0-9\-]+)\/(\d+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;

/* ───────────────────────── detail page ───────────────────────── */

/** Beer name lives in the <h1> on the detail page. */
export const DETAIL_NAME_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

/**
 * Rating block on a detail page looks roughly like:
 *   <div class="rating">…<span class="number">3.45</span>…</div>
 * We grab the first number out of any element carrying a "rating" class
 * so this stays robust to small markup shuffles.
 */
export const DETAIL_RATING_RE =
  /<[^>]+class="[^"]*\brating\b[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*\bnumber\b[^"]*"[^>]*>([\d.]+)<\/span>[\s\S]*?<\/(?:div|span|section)>/i;

/**
 * "Number of ratings" usually appears as
 *   "With 1,234 ratings"
 *   or  <span class="count">1234</span>
 */
export const DETAIL_RATING_COUNT_RE =
  /(?:With\s+([\d,]+)\s+ratings|<[^>]+class="[^"]*\bcount\b[^"]*"[^>]*>([\d,]+)<\/span>)/i;

/**
 * ABV often appears as:
 *   "ABV: 4.5%"
 *   <strong>ABV</strong> 4.5%
 *   or inside a styled span.
 */
export const DETAIL_ABV_RE = /(?:ABV|abv)[^<\d]{0,40}(\d+(?:\.\d+)?)\s*%/i;

/**
 * Style: a detail page carries a line like
 *   "Style:  India Pale Ale"
 *   or a link to /beerstyles/<id>/.
 */
export const DETAIL_STYLE_RE =
  /(?:Style|style)\s*[:：]?\s*<a[^>]+href="\/beerstyles\/[^"]+"[^>]*>([\s\S]*?)<\/a>|Style\s*[:：]?\s*([^\n<]+?)(?=<|$)/i;

/**
 * Brewery: detail page carries
 *   <a href="/brewers/<slug>/<id>/">熊猫精酿</a>
 */
export const DETAIL_BREWERY_RE =
  /<a[^>]+href="\/brewers\/([a-z0-9\-]+)\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/i;

/** Strip HTML tags from a captured inner-text blob. */
export const TAG_STRIP_RE = /<[^>]+>/g;

/** Collapse all whitespace (incl. NBSP, newlines) to a single space. */
export const WS_COLLAPSE_RE = /[\s ]+/g;
