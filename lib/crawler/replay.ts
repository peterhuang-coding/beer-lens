/**
 * lib/crawler/replay.ts
 *
 * Dev-mode replay CrawlDriver. Reads pre-recorded HTML fixtures from
 * data/crawler/_fixtures/ instead of hitting the network.
 *
 * Mapping rule:
 *   - URL hash → {source, slug} → file path
 *     e.g. https://untappd.com/b/some-slug/12345
 *          → data/crawler/_fixtures/untappd-some-slug-12345.html
 *     simpler: the worker hands us a `fixture_key` via
 *     `PageSnapshot` extension (we just put it in the URL fragment
 *     after `#fixture=`), and resolve() looks up that key.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  CrawlDriver,
  FetchOpts,
  PageSnapshot,
} from "./contracts.ts";

export interface ReplayDriverOptions {
  fixtures_dir: string;
  /** When true, missing fixture => fatal. Else 404 snapshot. */
  strict?: boolean;
}

const FIXTURE_SCHEME = "fixture://";

export class ReplayDriver implements CrawlDriver {
  readonly mode = "puppeteer" as const; // implements CrawlDriver; downstream distinguishes via constructor
  private readonly opts: Required<ReplayDriverOptions>;

  constructor(opts: ReplayDriverOptions) {
    this.opts = { strict: false, ...opts };
    if (!this.opts.fixtures_dir) {
      throw new Error("ReplayDriver requires fixtures_dir");
    }
  }

  /**
   * Resolve URL to a snapshot. URL must use the `fixture://` scheme
   * with the basename of the fixture file as the path.
   *   e.g. fixture://sample-untappd.html
   */
  async fetchPage(url: string, _fetchOpts: FetchOpts): Promise<PageSnapshot> {
    const key = this._parseFixtureKey(url);
    const file = path.join(this.opts.fixtures_dir, key);
    let html: string;
    try {
      html = await fs.readFile(file, "utf8");
    } catch (err) {
      if (this.opts.strict) throw err;
      return { url, html: "", status: 404, retry_after_ms: null };
    }
    return { url, html, status: 200, retry_after_ms: null };
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  /**
   * Convenience: list available fixture keys.
   */
  async listFixtures(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.opts.fixtures_dir);
      return files.filter((f) => f.endsWith(".html") || f.endsWith(".htm"));
    } catch {
      return [];
    }
  }

  /**
   * URL can be either:
   *   fixture://basename.html
   *   https://...#fixture=basename.html
   */
  private _parseFixtureKey(url: string): string {
    if (url.startsWith(FIXTURE_SCHEME)) {
      return url.slice(FIXTURE_SCHEME.length);
    }
    const m = url.match(/#fixture=([^&]+)/);
    if (m) return decodeURIComponent(m[1]!);
    throw new Error(
      `ReplayDriver cannot resolve non-fixture URL: ${url}. Use fixture:// scheme or #fixture= fragment.`,
    );
  }
}

export function makeReplayDriver(opts: ReplayDriverOptions): ReplayDriver {
  return new ReplayDriver(opts);
}
