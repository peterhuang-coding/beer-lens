import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../lib/crawler/cli.ts';
import type { CrawlDriver } from '../lib/crawler/contracts.ts';

class FixtureDriver implements CrawlDriver {
  mode = 'http' as const;
  calls: string[] = [];
  closed = false;
  failedId = '';
  listStatus = 200;
  async fetchPage(url: string) {
    this.calls.push(url);
    const isList = url.endsWith('/top');
    const id = url.split('/').at(-1);
    return { url, status: isList ? this.listStatus : id === this.failedId ? 503 : 200, retry_after_ms: null,
      html: isList ? [1, 2, 3, 4].map(n => `<a href="/b/beer-${n}/${n}">Beer ${n}</a>`).join('')
      : `<h1>Beer ${id}</h1><p class="abv">6.5% ABV</p><span class="rating">4.25</span><p>1,234 ratings</p>` };
  }
  async close() { this.closed = true; }
}
const args = () => parseArgs(['--source', 'untappd', '--limit', '2', '--concurrency', '4']);
async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'beer-live-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('live runner fetches only reserved limit and writes complete records with empty optional arrays', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    const driver = new FixtureDriver();
    const result = await runLiveCrawl({ args: args(), driver, outputDir });
    assert.equal(result.done, 2); assert.equal(result.failed, 0); assert.equal(driver.calls.length, 3); assert.equal(driver.closed, true);
    const lines = (await readFile(join(outputDir, 'beers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 3); assert.ok(lines[0]._meta);
    assert.equal(lines[1].abv, 6.5); assert.equal(lines[1].rating_count, 1234); assert.deepEqual(lines[1].food_pairing, []);
    assert.equal(lines[1].source, 'untappd'); assert.equal(lines[1].verified, undefined);
  });
});
test('live runner reports failed HTTP details and persists only successful records', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    const driver = new FixtureDriver(); driver.failedId = '2';
    const result = await runLiveCrawl({ args: args(), driver, outputDir });
    assert.equal(result.done, 1); assert.equal(result.failed, 1); assert.equal(result.errors[0].status, 503); assert.equal(driver.closed, true);
    const state = JSON.parse(await readFile(join(outputDir, '.state.json'), 'utf8'));
    assert.deepEqual(state.processed_ids, ['1']); assert.deepEqual(state.failed_ids, ['2']);
  });
});
test('live runner closes driver on list HTTP failure without creating output', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    const driver = new FixtureDriver(); driver.listStatus = 403;
    await assert.rejects(runLiveCrawl({ args: args(), driver, outputDir }), /HTTP 403/);
    assert.equal(driver.closed, true);
    await assert.rejects(readFile(join(outputDir, 'beers.jsonl')), { code: 'ENOENT' });
  });
});
test('live runner resumes from saved records without duplicating or losing earlier records', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    await runLiveCrawl({ args: args(), driver: new FixtureDriver(), outputDir });
    const driver = new FixtureDriver();
    const result = await runLiveCrawl({ args: { ...args(), resume: true }, driver, outputDir });
    assert.equal(result.done, 2); assert.equal(driver.calls.length, 3); assert.ok(driver.calls.every(url => !url.endsWith('/1') && !url.endsWith('/2')));
    const lines = (await readFile(join(outputDir, 'beers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 5);
  });
});
test('dry-run and zero limit never call driver or write output', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    const driver = new FixtureDriver();
    await runLiveCrawl({ args: { ...args(), dry_run: true }, driver, outputDir });
    await runLiveCrawl({ args: { ...args(), limit: 0 }, driver, outputDir });
    assert.deepEqual(driver.calls, []);
    await assert.rejects(readFile(join(outputDir, 'beers.jsonl')), { code: 'ENOENT' });
  });
});
test('live runner rejects unsupported filtering explicitly', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await assert.rejects(runLiveCrawl({ args: { ...args(), tag: 'china' }, driver: new FixtureDriver() }), /tag.*not supported/i);
});
test('RateBeer runner uses China list and writes its parsed fields through same output path', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    const calls: string[] = [];
    let closed = false;
    const driver: CrawlDriver = { mode: 'http', async close() { closed = true; }, async fetchPage(url) {
      calls.push(url);
      const name = url.endsWith('/country/46/') ? 'ratebeer-cn-list.html' : 'ratebeer-detail-cn.html';
      return { url, status: 200, retry_after_ms: null, html: await readFile(new URL(`../data/crawler/_fixtures/${name}`, import.meta.url), 'utf8') };
    } };
    const result = await runLiveCrawl({ args: { ...args(), source: 'ratebeer', tag: 'china', limit: 1 }, driver, outputDir });
    assert.equal(result.done, 1); assert.equal(result.failed, 0); assert.equal(closed, true); assert.equal(calls.length, 2);
    const record = JSON.parse((await readFile(join(outputDir, 'beers.jsonl'), 'utf8')).trim().split('\n')[1]);
    assert.equal(record.source, 'ratebeer'); assert.equal(record.abv, 6.5); assert.equal(record.rating_count, 1847);
  });
});
test('runner rejects a successful HTTP page containing no beer fields', async () => {
  const { runLiveCrawl } = await import('../lib/crawler/live-runner.ts');
  await temporary(async outputDir => {
    const driver = new FixtureDriver();
    const fetch = driver.fetchPage.bind(driver);
    driver.fetchPage = async url => {
      const page = await fetch(url);
      if (!url.endsWith('/top')) page.html = '<h1>Access challenge</h1>';
      return page;
    };
    const result = await runLiveCrawl({ args: args(), driver, outputDir });
    assert.equal(result.done, 0); assert.equal(result.failed, 2); assert.match(result.errors[0].message, /No beer detail fields/);
  });
});
test('HTML validation permits empty arrays without relaxing LLM validation or field types', async () => {
  const { validateBeerRecord } = await import('../lib/crawler/validate-beer-record.ts');
  const { parseDetail } = await import('../lib/crawler/untappd-parser.ts');
  const beer = parseDetail('<h1>Test</h1>', { source_id: '1', name: 'Test', url: 'https://untappd.com/b/test/1' });
  assert.throws(() => validateBeerRecord(beer), /non-empty string array/);
  assert.equal(validateBeerRecord(beer, { allowEmptyArrays: true }), beer);
  assert.throws(() => validateBeerRecord({ ...beer, food_pairing: [123] }, { allowEmptyArrays: true }), /non-empty strings/);
});
test('CLI wrapper reaches live runner for zero limit and keeps explicit dry-run offline', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const wrapper = fileURLToPath(new URL('../bin/beer-lens-crawl.mjs', import.meta.url));
  const env = { ...process.env, BEER_LENS_LIVE: '1', BEER_LENS_DRY_RUN: '0' };
  const live = await run(process.execPath, ['--experimental-strip-types', wrapper, '--source', 'untappd', '--limit', '0'], { env });
  assert.doesNotMatch(live.stderr, /stub|dev-integration/);
  const dry = await run(process.execPath, ['--experimental-strip-types', wrapper, '--source', 'untappd', '--dry-run'], { env });
  assert.match(dry.stdout, /DRY RUN/);
  const forced = await run(process.execPath, ['--experimental-strip-types', wrapper, '--source', 'untappd'], { env: { ...env, BEER_LENS_DRY_RUN: '1' } });
  assert.match(forced.stdout, /DRY RUN/);
});
