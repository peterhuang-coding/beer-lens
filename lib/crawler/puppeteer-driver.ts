/**
 * lib/crawler/puppeteer-driver.ts
 *
 * CrawlDriver implementation using Playwright Chromium in headless mode.
 *
 * Notes:
 *   - Lazy-loaded via `await import("playwright")`. If chromium is not
 *     installed the constructor throws a friendly error rather than
 *     crashing the import.
 *   - Internet is intentionally not touched in this module — it's the
 *     caller's responsibility to point at fixtures / replays. The
 *     `fetchPage` method will still hit the URL, but in this harness
 *     we wire it through ReplayDriver in dry-run / replay mode.
 *   - sandbox: true blocks network from already-restricted processes,
 *     we leave it off (defaults) so curl-style flows keep working.
 */

import type {
  CrawlDriver,
  FetchOpts,
  PageSnapshot,
} from "./contracts.ts";

export interface PuppeteerDriverOptions {
  /** When true, the browser does not actually launch. Useful in offline dev. */
  headless?: boolean;
  /** Override user agent. */
  user_agent?: string;
  /** Set true to allow actual network — leave false for fixture-only. */
  allow_network?: boolean;
  /** Optional page-level signal: abort() with reason on timeout. */
}

interface PlaywrightChromium {
  launch(opts?: Record<string, unknown>): Promise<unknown>;
}
interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

let _pwCache: PlaywrightModule | null = null;
let _pwLoadError: Error | null = null;

/**
 * Lazy-load `playwright`. Returns null on failure (e.g. browser binary
 * missing in offline env), letting the constructor fall back.
 */
export async function tryLoadPlaywright(): Promise<PlaywrightModule | null> {
  if (_pwCache) return _pwCache;
  if (_pwLoadError) return null;
  try {
    // dynamic import — playwright is a devDependency, no top-level await cost
    const mod = (await import("playwright")) as unknown as PlaywrightModule;
    _pwCache = mod;
    return mod;
  } catch (err) {
    _pwLoadError = err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

export class PuppeteerDriver implements CrawlDriver {
  readonly mode = "puppeteer" as const;
  private browser: unknown | null = null;
  private readonly opts: Required<PuppeteerDriverOptions>;
  private _initError: Error | null = null;
  private _initStarted = false;

  constructor(opts: PuppeteerDriverOptions = {}) {
    this.opts = {
      headless: opts.headless ?? true,
      user_agent:
        opts.user_agent ??
        "Mozilla/5.0 (compatible; beer-lens-crawler/dev; +https://beer-lens.local)",
      allow_network: opts.allow_network ?? false,
    };
  }

  /**
   * Initialize the browser. Idempotent. Returns true on success.
   * Returns false when playwright isn't usable (e.g. browsers missing
   * offline). The harness treats this as "degrade to replay".
   */
  async init(): Promise<boolean> {
    if (this.browser) return true;
    if (this._initError) return false;
    this._initStarted = true;
    const pw = await tryLoadPlaywright();
    if (!pw) {
      this._initError = new Error(
        "playwright module unavailable — fallback to replay driver",
      );
      return false;
    }
    try {
      // Type-narrowed through PlaywrightModule; we keep `unknown` to
      // avoid dragging Playwright's heavyweight types into the public surface.
      const browser = await pw.chromium.launch({
        headless: this.opts.headless,
      });
      this.browser = browser;
      return true;
    } catch (err) {
      this._initError = err instanceof Error ? err : new Error(String(err));
      return false;
    }
  }

  initStatus(): { ok: boolean; error: Error | null; attempted: boolean } {
    return {
      ok: this.browser !== null,
      error: this._initError,
      attempted: this._initStarted,
    };
  }

  async fetchPage(url: string, fetchOpts: FetchOpts): Promise<PageSnapshot> {
    if (!this.opts.allow_network) {
      throw new Error(
        `PuppeteerDriver.fetchPage called but allow_network=false (url=${url}). Use ReplayDriver in dev mode.`,
      );
    }
    if (!this.browser) {
      const ok = await this.init();
      if (!ok || !this.browser) {
        throw new Error(
          `PuppeteerDriver unavailable: ${this._initError?.message ?? "init failed"}`,
        );
      }
    }
    // We avoid a typed `import { Browser } from "playwright"` here so
    // that consumers without playwright installed still get a runtime
    // error rather than a compile-time one.
    const b = this.browser as {
      newContext: (opts: Record<string, unknown>) => Promise<{
        newPage: () => Promise<{
          goto: (url: string, opts: Record<string, unknown>) => Promise<{
            status: () => number;
            headers: () => Record<string, string>;
          }>;
          content: () => Promise<string>;
          setExtraHTTPHeaders?: (h: Record<string, string>) => Promise<void>;
          close: () => Promise<void>;
        }>;
        close: () => Promise<void>;
      }>;
    };
    const ctx = await b.newContext({
      userAgent: this.opts.user_agent,
    });
    const page = await ctx.newPage();
    try {
      // Apply jitter via a soft wait — does nothing if jitter_ms = 0
      if (fetchOpts.jitter_ms > 0) {
        await new Promise((r) => setTimeout(r, fetchOpts.jitter_ms));
      }
      const resp = await page.goto(url, {
        timeout: fetchOpts.timeout_ms,
        waitUntil: "domcontentloaded",
      });
      const status = resp ? resp.status() : 0;
      const headers = resp ? resp.headers() : {};
      const html = await page.content();
      const retryAfterHeader = headers["retry-after"] ?? headers["Retry-After"];
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      return {
        url,
        html,
        status,
        retry_after_ms:
          Number.isFinite(retryAfterSec) && retryAfterSec >= 0
            ? retryAfterSec * 1000
            : null,
      };
    } finally {
      await page.close().catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.browser) return;
    const b = this.browser as { close: () => Promise<void> };
    await b.close().catch(() => undefined);
    this.browser = null;
  }
}

export function makePuppeteerDriver(
  opts: PuppeteerDriverOptions = {},
): PuppeteerDriver {
  return new PuppeteerDriver(opts);
}
