import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BeerRecord, CrawlDriver, CrawlOptions, CookieRef } from './contracts.ts';
import { parseList, parseDetail } from './untappd-parser.ts';
export interface UntappdCrawlerConfig { driver?: CrawlDriver; opts: CrawlOptions; }
const defaults: CrawlOptions = { source: 'untappd', concurrency: 2, limit: null, dry_run: false, resume: false, tag: null, cookies: [], retry_budget: 5, output_dir: 'data/crawler/untappd' };
export class UntappdCrawler {
  readonly driver?: CrawlDriver; readonly opts: CrawlOptions;
  constructor(config: UntappdCrawlerConfig) { this.driver = config.driver; this.opts = { ...defaults, ...config.opts, concurrency: Math.min(4, Math.max(1, config.opts.concurrency ?? 2)) }; }
  async *run(): AsyncIterable<BeerRecord> {
    const cookie: CookieRef = this.opts.cookies[0] ?? { name: 'fixture', file: 'fixture', qps_per_cookie: 1 };
    const listUrl = 'https://untappd.com/beers/top'; let entries: ReturnType<typeof parseList> = [];
    if (this.opts.dry_run && !this.driver) return;
    if (this.driver) { const page = await this.driver.fetchPage(listUrl, { cookie, jitter_ms: 0, timeout_ms: 30000 }); entries = parseList(page.html); }
    entries = this.opts.limit == null ? entries : entries.slice(0, Math.max(0, this.opts.limit));
    if (this.opts.dry_run) return;
    const output = join(this.opts.output_dir, 'beers.jsonl'); await mkdir(this.opts.output_dir, { recursive: true });
    if (!this.opts.resume) await appendFile(output, JSON.stringify({ _meta: { source: 'untappd', license_note: 'untappd public pages; no check-in/heart; dev-mode replay', generated_at: new Date().toISOString() } }) + '\n');
    let next = 0; const workers = Array.from({ length: Math.min(this.opts.concurrency, entries.length) }, async () => { while (true) { const i = next++; if (i >= entries.length) return; const e = entries[i]; try { if (!this.driver) throw new Error('driver required'); const page = await this.driver.fetchPage(e.url, { cookie, jitter_ms: 0, timeout_ms: 30000 }); const beer = parseDetail(page.html, e); await appendFile(output, JSON.stringify(beer) + '\n'); results.push(beer); } catch { /* one beer must not stop the stream */ } } });
    const results: BeerRecord[] = []; await Promise.all(workers); for (const beer of results) yield beer;
  }
}
