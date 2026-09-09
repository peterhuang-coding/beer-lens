import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BeerRecord, CliArgs, CrawlDriver, FetchOpts } from './contracts.ts';
import { assertConcurrency } from './cli.ts';
import { parseList, parseDetail } from './untappd-parser.ts';
import { parseRatebeerList, parseRatebeerDetail } from './ratebeer-parser.ts';
import { RATEBEER_CHINA_LIST_URL } from './ratebeer-selectors.ts';
import { JsonlWriter } from './jsonl-writer.ts';
import { readState, writeState } from './signal.ts';
import { validateBeerRecord } from './validate-beer-record.ts';

export interface LiveRunOptions {
  args: CliArgs;
  driver?: CrawlDriver;
  outputDir?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}
export interface LiveRunResult {
  done: number;
  failed: number;
  interrupted: boolean;
  errors: { source_id: string; url: string; message: string; status?: number }[];
}
class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} fetching ${url}`);
    this.status = status;
  }
}
const fetchOptions: FetchOpts = {
  cookie: { name: 'public', file: '', qps_per_cookie: 1 },
  jitter_ms: 0,
  timeout_ms: 30000,
};

/** Fetch one public list page and its details; no authentication or verification is inferred. */
export async function runLiveCrawl(opts: LiveRunOptions): Promise<LiveRunResult> {
  const { args } = opts;
  assertConcurrency(args.concurrency);
  const result: LiveRunResult = { done: 0, failed: 0, interrupted: false, errors: [] };
  if (args.dry_run || args.limit === 0) return result;
  if (!['untappd', 'ratebeer'].includes(args.source)) throw new Error(`Live source not supported: ${args.source}`);
  if (args.tag && !(args.source === 'ratebeer' && args.tag === 'china')) {
    throw new Error(`Live tag '${args.tag}' is not supported for ${args.source}`);
  }
  const outputDir = opts.outputDir ?? join('data', 'crawler', args.source);
  const outputPath = join(outputDir, 'beers.jsonl');
  const prior: BeerRecord[] = [];
  const priorState = args.resume ? await readState(outputDir) : null;
  if (args.resume) {
    try {
      const raw = await readFile(outputPath, 'utf8');
      for (const line of raw.split('\n').filter(line => line.trim())) {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null && '_meta' in parsed) continue;
        const record = validateBeerRecord(parsed, { allowEmptyArrays: true });
        if (record.source !== args.source) throw new Error('Resume output source mismatch');
        prior.push(record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const processed = new Set(prior.map(record => record.source_id));
  const failed = new Set(priorState?.failed_ids ?? []);
  const driver = opts.driver ?? new (await import('./puppeteer-driver.ts')).PuppeteerDriver({ allow_network: true });
  const writer = new JsonlWriter({ output_path: outputPath, source: args.source, license_note: `${args.source} public pages; no verification inferred` });
  const records: BeerRecord[] = [];
  try {
    const fetchHtml = async (url: string) => {
      const page = await driver.fetchPage(url, fetchOptions);
      if (page.status < 200 || page.status >= 300) throw new HttpError(url, page.status);
      return page.html;
    };
    if (opts.signal?.aborted) return { ...result, interrupted: true };
    const listUrl = args.source === 'untappd' ? 'https://untappd.com/beers/top' : RATEBEER_CHINA_LIST_URL;
    const html = await fetchHtml(listUrl);
    const entries = args.source === 'untappd' ? parseList(html) : parseRatebeerList(html);
    if (!entries.length) throw new Error(`No beer links parsed from ${listUrl}; check access or selectors`);
    // Reserve the limited candidate set before starting any concurrent worker.
    const pending = entries.filter(entry => !processed.has(entry.source_id));
    const candidates = args.limit === null ? pending : pending.slice(0, args.limit);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(args.concurrency, candidates.length) }, async () => {
      while (!opts.signal?.aborted) {
        const entry = candidates[next++];
        if (!entry) return;
        try {
          const detail = await fetchHtml(entry.url);
          if (!/<h1\b[^>]*>[\s\S]*?<\/h1>/i.test(detail)) throw new Error('Beer detail heading missing; check access or selectors');
          const record = args.source === 'untappd' ? parseDetail(detail, entry) : {
            ...parseRatebeerDetail(detail, { ...entry, brewery_slug: 'brewery_slug' in entry && typeof entry.brewery_slug === 'string' ? entry.brewery_slug : null }),
            source: args.source, source_id: entry.source_id, url: entry.url, fetched_at: new Date().toISOString(),
          };
          validateBeerRecord(record, { allowEmptyArrays: true });
          if (record.style === null && record.abv === null && record.rating === null) {
            throw new Error('No beer detail fields parsed; check access or selectors');
          }
          records.push(record);
          processed.add(entry.source_id);
          failed.delete(entry.source_id);
          result.done++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push({ source_id: entry.source_id, url: entry.url, message, ...(error instanceof HttpError ? { status: error.status } : {}) });
          failed.add(entry.source_id);
          result.failed++;
          opts.log?.(`[crawler] failed ${entry.url}: ${message}`);
        }
      }
    }));
    result.interrupted = opts.signal?.aborted ?? false;
    await writer.open();
    for (const record of [...prior, ...records]) await writer.writeRecord({ ...record });
    await writer.close();
    await writeState(outputDir, {
      source: args.source, started_at: priorState?.started_at ?? new Date().toISOString(), updated_at: new Date().toISOString(),
      cursor: null, processed_ids: [...processed], failed_ids: [...failed],
      opts: { concurrency: args.concurrency, limit: args.limit, tag: args.tag },
    });
    opts.log?.(`[crawler] source=${args.source} done=${result.done} failed=${result.failed} output=${outputPath}`);
    return result;
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    await driver.close();
  }
}
