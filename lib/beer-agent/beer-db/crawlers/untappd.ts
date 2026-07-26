/**
 * Untappd Crawler — 从 Untappd 网站抓取热门啤酒数据。
 *
 * 此文件是需求规格 + 桩代码。实际的爬虫实现交给其他 AI / 开发者完成。
 * 接口定义在这里，实现后直接替换桩代码即可。
 *
 * ## 爬取目标
 *
 * 从以下页面抓取啤酒列表：
 *   1. https://untappd.com/beer/top_rated              — 全站最高评分
 *   2. https://untappd.com/beer/top_rated?type={style}  — 按风格
 *   3. https://untappd.com/beer/top_rated?country={cc}  — 按国家
 *
 * ## 抓取字段（每条啤酒）
 *
 * | 字段          | CSS 选择器 / 来源         | 示例                          |
 * |---------------|--------------------------|-------------------------------|
 * | name          | .beer-details .name      | Pliny the Elder               |
 * | brewery       | .beer-details .brewery   | Russian River Brewing Company |
 * | style         | .beer-details .style     | Imperial IPA                  |
 * | abv           | .beer-details .abv       | 8.0                           |
 * | rating        | .rating .num             | 4.52                          |
 * | ratings_count | .rating .count          | 245,832                       |
 * | untappd_url   | a.track-click 的 href     | /b/.../4499                   |
 * | country       | 酒厂页面 / 面包屑         | United States                 |
 * | label_image   | .beer-label img 的 src   | https://untappd.akamaized...  |
 *
 * ## 反爬策略
 *
 * - User-Agent: 模拟 Chrome macOS（可 sticky）
 * - 请求间隔: 2-5 秒随机
 * - 失败重试: 3 次，指数退避 (2s, 4s, 8s)
 * - 支持 HTTP 代理 + Cookie session
 * - 20 秒请求超时（undici headersTimeout/bodyTimeout）
 * - Retry-After 解析（429 用服务器秒数退避）
 *
 * ## 去重策略
 *
 * - 按 name + brewery 组合去重
 * - 已存在于 untappd_cache 表的条目跳过（forceUpsert=true 时强制返回）
 * - 评分有变化的条目更新
 *
 * ## 输出
 *
 * 返回 CrawlResult，由 updater.ts 写入 SQLite。output 含 untappd_id 供 writer 使用。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CrawlBeer = {
  name: string;
  brewery: string;
  style: string;
  abv: number;
  rating: number;
  ratings_count: number;
  untappd_url: string;
  /** Untappd numeric beer id extracted from URL slug (e.g. 4499 from /b/.../4499) */
  untappd_id: string;
  country: string;
  label_image: string;
};

export type CrawlResult = {
  beers: CrawlBeer[];
  totalPages: number;
  pagesCrawled: number;
  errors: string[];
  /** Audit info: resolved options + session metadata. */
  session?: {
    startedAt: string;
    completedAt: string;
    forceUpsert: boolean;
    userAgent: string;
    proxyEnabled: boolean;
    proxyHost?: string;
  };
};

export type CrawlOptions = {
  /** 按风格抓取 (e.g. ["ipa", "stout", "sour"]) */
  styles?: string[];
  /** 按国家抓取 */
  countries?: string[];
  /** 最大抓取条数 */
  limit?: number;
  /** HTTP 代理 */
  proxy?: string;
  /** 强制返回所有记录（跳过 dedup-vs-DB 判断，由 writer 决定 update/insert） */
  forceUpsert?: boolean;
  /** Custom user agent (overrides random rotation; sticky for the whole crawl) */
  userAgent?: string;
  /** Cookie string (sent verbatim in `Cookie:` header; useful for logged-in sessions) */
  cookie?: string;
  /** Request timeout in milliseconds (default 20_000) */
  timeoutMs?: number;
};

/** Default env-derived credentials. Read once at module load. */
const ENV_PROXY = process.env.UNTAPPD_PROXY_URL ?? "";
const ENV_USER_AGENT = process.env.UNTAPPD_USER_AGENT ?? "";
const ENV_COOKIE = process.env.UNTAPPD_COOKIE ?? "";
const ENV_TIMEOUT = parseInt(process.env.UNTAPPD_TIMEOUT_MS ?? "20000", 10);

// ── Constants ──

const UNTAPPD_BASE = "https://untappd.com";
const TOP_RATED_PATH = "/beer/top_rated";
const BEERS_PER_PAGE = 25;
const DEFAULT_LIMIT = 250;

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
];

const DEFAULT_STYLES = [
  "ipa", "hazy-ipa", "stout", "sour", "lager",
  "pilsner", "pale-ale", "wheat", "porter", "belgian",
];

// fetch options with undici dispatcher / timeouts (for proxy)
type FetchInit = RequestInit & {
  dispatcher?: unknown;
  headersTimeout?: number;
  bodyTimeout?: number;
};

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 2000, max = 5000): Promise<void> {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Mask proxy URI for safe logging: keep scheme://host:port but strip
 * any embedded user/password and query string.
 *
 * Examples:
 *   http://user:pass@proxy.example.com:8080  → http://proxy.example.com:8080
 *   socks5://1.2.3.4:1080?token=xxx          → socks5://1.2.3.4:1080
 *   malformed URI                             → "***" (no leak even on parse failure)
 */
function sanitizeProxyForLog(proxy: string | undefined): string {
  if (!proxy) return "";
  try {
    const u = new URL(proxy);
    // Rebuild without userinfo or query
    const safe = `${u.protocol}//${u.host}`;
    return safe;
  } catch {
    // Never leak a raw un-parseable URI
    return "***";
  }
}

/** Normalise a style name for Untappd URL params (e.g. "Hazy IPA" → "hazy-ipa") */
function normalizeStyle(style: string): string {
  return style.trim().toLowerCase().replace(/\s+/g, "-");
}

function buildUrl(page: number, style?: string, country?: string): string {
  const params = new URLSearchParams();
  if (style) params.set("type", style);
  if (country) params.set("country", country);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return `${UNTAPPD_BASE}${TOP_RATED_PATH}${qs ? `?${qs}` : ""}`;
}

/**
 * Parse the numeric Untappd beer id from a URL slug like:
 *   /b/russian-river-brewing-company/pliny-the-elder/4499
 * Returns empty string when not parseable.
 */
function extractUntappdId(url: string): string {
  if (!url) return "";
  const m = url.match(/\/b\/[^/]+\/[^/]+\/(\d+)/);
  return m ? m[1] : "";
}

/**
 * Parse the Retry-After header value.
 *   - Integer (seconds): "60" → 60_000
 *   - HTTP-date: → future ms - now
 *   - missing/invalid: 0
 */
function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  // Plain seconds
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  // HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return 0;
}

/**
 * Fetch a URL with retry, exponential backoff, anti-bot detection, and
 * 20s per-request timeout (configurable).
 *
 * Honors Retry-After from 429 responses. Sticky UA/cookie via the
 * resolved SessionConfig (one stable UA + cookie for the entire caller's crawl).
 *
 * Returns HTML string on success, null on unrecoverable failure.
 */
async function fetchWithRetry(
  url: string,
  options: {
    proxy?: string;
    maxRetries?: number;
    userAgent: string;
    cookie?: string;
    timeoutMs: number;
  },
  errors: string[],
): Promise<string | null> {
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        "User-Agent": options.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: UNTAPPD_BASE,
      };
      if (options.cookie) headers["Cookie"] = options.cookie;

      const init: FetchInit = {
        headers,
        redirect: "follow" as const,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
      };

      // Proxy support via undici ProxyAgent, with configured timeouts
      if (options.proxy) {
        try {
          const undici = await import("undici");
          init.dispatcher = new undici.ProxyAgent({
            uri: options.proxy,
            headersTimeout: options.timeoutMs,
            bodyTimeout: options.timeoutMs,
          });
        } catch {
          console.warn("[crawler:untappd] undici ProxyAgent unavailable, proxy ignored");
        }
      }

      const response = await fetch(url, init);

      // 429 — rate limited. Honor Retry-After if present, else fallback 60s.
      if (response.status === 429) {
        const retryMs = parseRetryAfter(response.headers.get("Retry-After"));
        const waitMs = retryMs > 0 ? retryMs : 60_000;
        console.warn(
          `[crawler:untappd] 429 rate-limited at ${url} — pausing ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`,
        );
        errors.push(`429 at ${url} (waited ${Math.round(waitMs / 1000)}s)`);
        await sleep(waitMs);
        continue;
      }

      // 403 / 503 — might be Cloudflare or captcha
      if (response.status === 403 || response.status === 503) {
        const text = await response.text();
        if (/cloudflare|captcha|challenge|cf-challenge|recaptcha|hcaptcha/i.test(text)) {
          console.warn(`[crawler:untappd] Anti-bot block (${response.status}) at ${url} — skipping`);
          errors.push(`Anti-bot block (${response.status}) at ${url}`);
          return null;
        }
      }

      if (!response.ok) {
        const msg = `HTTP ${response.status} at ${url}`;
        console.warn(`[crawler:untappd] ${msg} (attempt ${attempt + 1}/${maxRetries})`);
        errors.push(msg);
        await sleep(Math.pow(2, attempt + 1) * 1000); // 2s → 4s → 8s
        continue;
      }

      const html = await response.text();

      // Check for captcha / challenge in response body
      if (/cf-challenge|recaptcha|hcaptcha|cf-mitigated/i.test(html)) {
        console.warn(`[crawler:untappd] Capta/challenge page at ${url} — skipping`);
        errors.push(`Captcha page at ${url}`);
        return null;
      }

      return html;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[crawler:untappd] fetch error: ${msg} (attempt ${attempt + 1}/${maxRetries})`);
      errors.push(`Fetch error: ${msg}`);
      await sleep(Math.pow(2, attempt + 1) * 1000);
    }
  }

  console.error(`[crawler:untappd] failed after ${maxRetries} retries: ${url}`);
  return null;
}

/** Strip HTML tags and decode common entities */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .trim();
}

function parseAbv(text: string): number {
  const m = text.match(/(\d+\.?\d*)\s*%/);
  return m ? parseFloat(m[1]) : 0;
}

function parseRating(text: string): number {
  const m = text.match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseCount(text: string): number {
  const cleaned = text.replace(/[^0-9]/g, "");
  return cleaned ? parseInt(cleaned, 10) : 0;
}

/** Convert URL slug to readable name (e.g. "pliny-the-elder" → "Pliny the Elder") */
function slugToName(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Parse beer entries from an Untappd listing-page HTML.
 *
 * Strategy: find all /b/ beer links, then extract fields from the
 * surrounding HTML context. Multiple regex fallbacks per field
 * ensure robustness against HTML structure variations.
 */
function parseBeerList(html: string, fallbackCountry?: string): CrawlBeer[] {
  const beers: CrawlBeer[] = [];
  const seen = new Set<string>();

  // Find all beer links: /b/{brewery-slug}/{beer-slug}/{beer-id}
  const linkRegex = /href="(\/b\/[^"]+)"/g;
  const linkMatches = [...html.matchAll(linkRegex)];

  if (linkMatches.length === 0) {
    console.warn("[crawler:untappd] no /b/ links found in page HTML");
    return beers;
  }

  for (const linkMatch of linkMatches) {
    const url = linkMatch[1];
    const urlIndex = linkMatch.index ?? 0;

    // Context window around this link
    const windowStart = Math.max(0, urlIndex - 2500);
    const windowEnd = Math.min(html.length, urlIndex + 3500);
    const chunk = html.substring(windowStart, windowEnd);

    // ── Name ──
    let name = "";
    const nameMatch = chunk.match(/<p[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (nameMatch) name = stripTags(nameMatch[1]);
    if (!name) {
      const linkTextMatch = chunk.match(/href="\/b\/[^"]*"[^>]*>([^<]+)</);
      if (linkTextMatch) name = stripTags(linkTextMatch[1]);
    }
    if (!name) {
      const dataNameMatch = chunk.match(/data-name="([^"]+)"/i);
      if (dataNameMatch) name = dataNameMatch[1];
    }
    // Fallback: derive from URL slug
    if (!name) {
      const slugMatch = url.match(/\/b\/[^/]+\/([^/]+)\//);
      if (slugMatch) name = slugToName(slugMatch[1]);
    }
    if (!name) continue;

    // ── Brewery ──
    let brewery = "";
    const breweryMatch = chunk.match(/<p[^>]*class="[^"]*\bbrewery\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (breweryMatch) brewery = stripTags(breweryMatch[1]);
    if (!brewery) {
      const breweryLinkMatch = chunk.match(/href="\/w\/[^"]*"[^>]*>([^<]+)</);
      if (breweryLinkMatch) brewery = stripTags(breweryLinkMatch[1]);
    }
    if (!brewery) {
      const slugMatch = url.match(/\/b\/([^/]+)\//);
      if (slugMatch) brewery = slugToName(slugMatch[1]);
    }

    // ── Style ──
    let style = "";
    const styleMatch = chunk.match(/<p[^>]*class="[^"]*\bstyle\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (styleMatch) style = stripTags(styleMatch[1]);
    if (!style) {
      const dataStyleMatch = chunk.match(/data-style="([^"]+)"/i);
      if (dataStyleMatch) style = dataStyleMatch[1];
    }

    // ── ABV ──
    let abv = 0;
    const abvMatch = chunk.match(/<p[^>]*class="[^"]*\babv\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (abvMatch) abv = parseAbv(stripTags(abvMatch[1]));
    if (!abv) {
      const abvTextMatch = chunk.match(/(\d+\.?\d*)\s*%\s*ABV/i);
      if (abvTextMatch) abv = parseFloat(abvTextMatch[1]);
    }

    // ── Rating ──
    let rating = 0;
    const ratingMatch = chunk.match(/class="[^"]*\bnum\b[^"]*"[^>]*>([\s\S]*?)<\//i);
    if (ratingMatch) rating = parseRating(stripTags(ratingMatch[1]));
    if (!rating) {
      const dataRatingMatch = chunk.match(/data-rating="(\d+\.?\d*)"/i);
      if (dataRatingMatch) rating = parseFloat(dataRatingMatch[1]);
    }

    // ── Ratings count ──
    let ratings_count = 0;
    const countMatch = chunk.match(/class="[^"]*\bcount\b[^"]*"[^>]*>([\s\S]*?)<\//i);
    if (countMatch) ratings_count = parseCount(stripTags(countMatch[1]));

    // ── Label image ──
    let label_image = "";
    const imgMatch = chunk.match(
      /<img[^>]*src="(https?:\/\/[^"]*(?:untappd|akamaized|gravatar)[^"]*)"/i,
    );
    if (imgMatch) label_image = imgMatch[1];

    // ── Country ──
    let country = fallbackCountry ?? "";
    if (!country) {
      const countryMatch = chunk.match(/class="[^"]*\bcountry\b[^"]*"[^>]*>([^<]+)</i);
      if (countryMatch) country = stripTags(countryMatch[1]);
    }

    // Full URL
    const untappd_url = url.startsWith("http") ? url : `${UNTAPPD_BASE}${url}`;
    const untappd_id = extractUntappdId(untappd_url);

    // Deduplicate within this page
    const key = `${name.toLowerCase()}|${brewery.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    beers.push({
      name,
      brewery,
      style: style || "Unknown",
      abv,
      rating,
      ratings_count,
      untappd_url,
      untappd_id,
      country,
      label_image,
    });
  }

  return beers;
}

/** Query existing entries in untappd_cache to skip duplicates. */
async function getExistingUntappdKeys(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-c",
        `import sqlite3, json
con = sqlite3.connect('.beer-data/beer.db')
rows = con.execute('SELECT name, brewery FROM untappd_cache').fetchall()
con.close()
print(json.dumps([[r[0] or '', r[1] or ''] for r in rows]))`,
      ],
      { timeout: 10_000 },
    );
    const pairs: string[][] = JSON.parse(stdout.trim());
    return new Set(pairs.map(([n, b]) => `${n.toLowerCase()}|${b.toLowerCase()}`));
  } catch (err) {
    console.warn(
      "[crawler:untappd] could not read existing cache:",
      err instanceof Error ? err.message : err,
    );
    return new Set();
  }
}

// ── Main functions ──

/**
 * Resolve session-level config: stickiness for UA/cookie, timeouts, and a
 * sanitized proxy descriptor suitable for logging.
 */
function resolveSession(options: CrawlOptions) {
  const proxy = options.proxy ?? (ENV_PROXY || undefined);
  const userAgent = options.userAgent ?? (ENV_USER_AGENT || randomUserAgent());
  const cookie = options.cookie ?? (ENV_COOKIE || undefined);
  const timeoutMs = options.timeoutMs ?? ENV_TIMEOUT;
  return {
    proxy,
    userAgent,
    cookie,
    timeoutMs,
    proxyHost: proxy ? sanitizeProxyForLog(proxy) : undefined,
  };
}

/**
 * 执行 Untappd 抓取。
 *
 * 爬取 top_rated 页面，按风格/国家筛选，解析啤酒数据并去重。
 * 返回 CrawlResult 供 updater.ts 写入 SQLite。
 *
 * Sticky session: one UA + cookie for the entire crawl (avoids
 * per-request fingerprint jitter that triggers anti-bot).
 *
 * When `options.forceUpsert === true`, the dedup-against-DB step is
 * skipped — every parsed beer is returned and the writer decides
 * whether to insert or update.
 */
export async function crawlUntappd(options: CrawlOptions = {}): Promise<CrawlResult> {
  const startedAt = new Date().toISOString();
  const styles = (options.styles?.length ? options.styles : DEFAULT_STYLES).map(normalizeStyle);
  const countries = options.countries ?? [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxPages = Math.ceil(limit / BEERS_PER_PAGE);
  const forceUpsert = options.forceUpsert === true;

  const session = resolveSession(options);

  const errors: string[] = [];
  const allBeers: CrawlBeer[] = [];
  const seenKeys = new Set<string>();
  let totalPages = 0;
  let pagesCrawled = 0;

  console.log(
    `[crawler:untappd] start: styles=[${styles.join(",")}] countries=[${countries.join(",")}] limit=${limit} forceUpsert=${forceUpsert} proxy=${session.proxyHost ?? "off"} timeoutMs=${session.timeoutMs}`,
  );

  // Get existing cache keys for dedup (skipped if forceUpsert)
  const existingKeys = forceUpsert ? new Set<string>() : await getExistingUntappdKeys();
  if (!forceUpsert && existingKeys.size > 0) {
    console.log(`[crawler:untappd] ${existingKeys.size} existing entries in untappd_cache — will skip`);
  }

  // Build crawl targets (combinations of style + country)
  const targets: Array<{ style?: string; country?: string; label: string }> = [];

  if (countries.length === 0) {
    // No country filter: global top + per-style
    targets.push({ label: "global" });
    for (const style of styles) {
      targets.push({ style, label: style });
    }
  } else {
    // With country filter
    for (const country of countries) {
      targets.push({ country, label: `country:${country}` });
      for (const style of styles) {
        targets.push({ style, country, label: `${style}/${country}` });
      }
    }
  }

  for (const target of targets) {
    if (allBeers.length >= limit) break;

    console.log(`[crawler:untappd] target: ${target.label}`);

    for (let page = 1; page <= maxPages; page++) {
      if (allBeers.length >= limit) break;

      const url = buildUrl(page, target.style, target.country);

      // Random delay between requests (skip on very first request)
      if (pagesCrawled > 0) {
        await randomDelay();
      }

      const html = await fetchWithRetry(
        url,
        {
          proxy: session.proxy,
          userAgent: session.userAgent,
          cookie: session.cookie,
          timeoutMs: session.timeoutMs,
        },
        errors,
      );
      if (!html) {
        console.warn(`[crawler:untappd] no HTML for ${target.label} p${page}, skipping target`);
        break;
      }

      pagesCrawled++;
      totalPages = Math.max(totalPages, page);

      const pageBeers = parseBeerList(html, target.country);
      console.log(`[crawler:untappd] ${target.label} p${page}: ${pageBeers.length} beers parsed`);

      if (pageBeers.length === 0) {
        console.log(`[crawler:untappd] ${target.label} p${page}: no beers, stopping target`);
        break;
      }

      // Add beers with dedup (DB-dedup skipped when forceUpsert)
      let addedThisPage = 0;
      for (const beer of pageBeers) {
        if (allBeers.length >= limit) break;
        const key = `${beer.name.toLowerCase()}|${beer.brewery.toLowerCase()}`;
        if (seenKeys.has(key)) continue;
        if (existingKeys.has(key)) continue;
        seenKeys.add(key);
        allBeers.push(beer);
        addedThisPage++;
      }

      console.log(
        `[crawler:untappd] ${target.label} p${page}: +${addedThisPage} new (total: ${allBeers.length})`,
      );

      // Partial page = last page
      if (pageBeers.length < BEERS_PER_PAGE) break;
    }

    // Delay between targets
    if (allBeers.length < limit) {
      await randomDelay(3000, 6000);
    }
  }

  const completedAt = new Date().toISOString();

  console.log(
    `[crawler:untappd] done: ${allBeers.length} beers, ${pagesCrawled} pages, ${errors.length} errors`,
  );

  return {
    beers: allBeers,
    totalPages,
    pagesCrawled,
    errors,
    session: {
      startedAt,
      completedAt,
      forceUpsert,
      userAgent: session.userAgent,
      proxyEnabled: Boolean(session.proxy),
      proxyHost: session.proxyHost,
    },
  };
}

/**
 * 抓取单个啤酒的详细信息页。
 *
 * URL 格式: https://untappd.com/b/{brewery-slug}/{beer-slug}/{beer-id}
 */
export async function crawlBeerDetail(
  untappdUrl: string,
  options: CrawlOptions = {},
): Promise<CrawlBeer | null> {
  const url = untappdUrl.startsWith("http") ? untappdUrl : `${UNTAPPD_BASE}${untappdUrl}`;
  const errors: string[] = [];
  const session = resolveSession(options);

  console.log(`[crawler:untappd] detail: ${url}`);
  const html = await fetchWithRetry(
    url,
    {
      proxy: session.proxy,
      userAgent: session.userAgent,
      cookie: session.cookie,
      timeoutMs: session.timeoutMs,
    },
    errors,
  );
  if (!html) {
    console.warn(`[crawler:untappd] detail fetch failed: ${url}`);
    return null;
  }

  // Name: <h1> or .name
  let name = "";
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) name = stripTags(h1Match[1]);
  if (!name) {
    const nameMatch = html.match(/<p[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (nameMatch) name = stripTags(nameMatch[1]);
  }
  if (!name) {
    const slugMatch = url.match(/\/b\/[^/]+\/([^/]+)\//);
    if (slugMatch) name = slugToName(slugMatch[1]);
  }
  if (!name) {
    console.warn(`[crawler:untappd] detail: could not parse name from ${url}`);
    return null;
  }

  // Brewery
  let brewery = "";
  const breweryLinkMatch = html.match(/href="\/w\/[^"]*"[^>]*>([^<]+)</);
  if (breweryLinkMatch) brewery = stripTags(breweryLinkMatch[1]);
  if (!brewery) {
    const breweryMatch = html.match(/<p[^>]*class="[^"]*\bbrewery\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (breweryMatch) brewery = stripTags(breweryMatch[1]);
  }

  // Style
  let style = "";
  const styleMatch = html.match(/<p[^>]*class="[^"]*\bstyle\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (styleMatch) style = stripTags(styleMatch[1]);

  // ABV
  let abv = 0;
  const abvMatch = html.match(/(\d+\.?\d*)\s*%\s*ABV/i);
  if (abvMatch) abv = parseFloat(abvMatch[1]);

  // Rating
  let rating = 0;
  const ratingMatch = html.match(/class="[^"]*\bnum\b[^"]*"[^>]*>([\s\S]*?)<\//i);
  if (ratingMatch) rating = parseRating(stripTags(ratingMatch[1]));
  if (!rating) {
    const dataRatingMatch = html.match(/data-rating="(\d+\.?\d*)"/i);
    if (dataRatingMatch) rating = parseFloat(dataRatingMatch[1]);
  }

  // Ratings count
  let ratings_count = 0;
  const countMatch = html.match(/class="[^"]*\bcount\b[^"]*"[^>]*>([\s\S]*?)<\//i);
  if (countMatch) ratings_count = parseCount(stripTags(countMatch[1]));

  // Country
  let country = "";
  const countryMatch = html.match(/class="[^"]*\bcountry\b[^"]*"[^>]*>([^<]+)</i);
  if (countryMatch) country = stripTags(countryMatch[1]);

  // Label image
  let label_image = "";
  const imgMatch = html.match(
    /<img[^>]*src="(https?:\/\/[^"]*(?:untappd|akamaized)[^"]*)"/i,
  );
  if (imgMatch) label_image = imgMatch[1];

  return {
    name,
    brewery,
    style: style || "Unknown",
    abv,
    rating,
    ratings_count,
    untappd_url: url,
    untappd_id: extractUntappdId(url),
    country,
    label_image,
  };
}
