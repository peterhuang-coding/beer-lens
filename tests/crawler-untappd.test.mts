import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises';
import { parseList, parseDetail } from '../lib/crawler/untappd-parser.ts'; import { UntappdCrawler } from '../lib/crawler/untappd.ts'; import type { CrawlDriver } from '../lib/crawler/contracts.ts';
const top = await readFile(new URL('../data/crawler/_fixtures/untappd-top.html', import.meta.url), 'utf8'); const detail = await readFile(new URL('../data/crawler/_fixtures/untappd-detail-info.html', import.meta.url), 'utf8');
test('parses list page', () => assert.equal(parseList(top).length, 5));
test('parses five detail panels', async () => { for (const tab of ['info','ratings','tags','food','similar']) { const html = await readFile(new URL(`../data/crawler/_fixtures/untappd-detail-${tab}.html`, import.meta.url), 'utf8'); const b = parseDetail(html, parseList(top)[0]); assert.equal(b.source, 'untappd'); } });
class Mock implements CrawlDriver { mode = 'http' as const; calls = 0; async fetchPage(url: string) { this.calls++; return { url, html: url.endsWith('/top_rated') ? top : detail, status: 200, retry_after_ms: null }; } async close() {} }
test('limit stops at 2 and concurrency is capped', async () => { const d = new Mock(); const out = []; for await (const b of new UntappdCrawler({ driver: d, opts: { source:'untappd', concurrency:2, limit:2, dry_run:false, resume:true, tag:null, cookies:[], retry_budget:1, output_dir:'/tmp/untappd-test' } }).run()) out.push(b); assert.equal(out.length, 2); assert.equal(d.calls, 3); });
test('dry-run without driver does not call driver', async () => { const out=[]; for await (const b of new UntappdCrawler({ opts: { source:'untappd', concurrency:2, limit:10, dry_run:true, resume:false, tag:null, cookies:[], retry_budget:1, output_dir:'/tmp/x' } }).run()) out.push(b); assert.equal(out.length,0); });
test('detail parser remains usable after failed item', () => { assert.equal(parseDetail(detail, {source_id:'1',name:'x',url:'https://untappd.com/beer/1'}).name, 'Fixture Beer'); });

test('list discovers canonical slug links without data IDs and ignores unrelated links', () => {
  const html = `<div class="beer-item"><a href="/brewery/18">Brewery</a>
    <a href="/b/example-ipa/123"><img src="label.png"></a>
    <p class="name"><a href="/b/example-ipa/123">Example IPA</a></p></div>
    <div data-beer-id="456"><a href="https://untappd.com/b/second-beer/456">Second Beer</a></div>
    <a href="https://example.com/b/external/789">External</a>
    <a href="/b/example-ipa/123?ref=top">Example IPA duplicate</a>`;
  assert.deepEqual(parseList(html), [
    { source_id: '123', name: 'Example IPA', url: 'https://untappd.com/b/example-ipa/123' },
    { source_id: '456', name: 'Second Beer', url: 'https://untappd.com/b/second-beer/456' },
  ]);
});
const detailBase = { source_id: '123', name: 'Example IPA', url: 'https://untappd.com/b/example-ipa/123' };
test('missing or unavailable detail numbers remain null', () => {
  for (const html of ['<h1>Example IPA</h1>', '<p>ABV N/A</p><p>IBU N/A</p><p>1,234 ratings</p>']) {
    const beer = parseDetail(html, detailBase);
    assert.equal(beer.abv, null);
    assert.equal(beer.ibu, null);
    assert.equal(beer.rating, null);
  }
  assert.equal(parseDetail('<h1>Example IPA</h1>', detailBase).rating_count, null);
});
test('detail parses thousands counts and values before or after their labels', () => {
  for (const html of [
    '<p class="abv">6.5% ABV</p><p class="ibu">40 IBU</p><span class="rating">4.25</span><p>1,234 ratings</p>',
    '<p>ABV <span>6.5%</span></p><p>IBU <span>40</span></p><p>4.25 / 5</p><p>Ratings: 1,234</p>',
  ]) {
    const beer = parseDetail(html, detailBase);
    assert.equal(beer.abv, 6.5);
    assert.equal(beer.ibu, 40);
    assert.equal(beer.rating, 4.25);
    assert.equal(beer.rating_count, 1234);
  }
});
