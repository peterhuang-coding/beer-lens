import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'beer-image-identity-'));
mkdirSync(join(dir, '.beer-data'));
copyFileSync(join(repo, '.beer-data/lookup.py'), join(dir, '.beer-data/lookup.py'));
const seed = spawnSync('python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE beers (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER)')
con.execute('CREATE TABLE untappd_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER, untappd_url TEXT, country TEXT, label_image TEXT)')
con.executemany('INSERT INTO untappd_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
 (1, 'Cyber Sue', 'Toppling Goliath', 'IPA', 7, 3.86, 500, 'https://untappd.com/b/cyber-sue/1', 'USA', ''),
 (2, 'Cyber Sue', 'Other Brewery', 'IPA', 7, 4.8, 5000, 'https://untappd.com/b/cyber-sue/2', 'USA', ''),
 (3, 'Pseudo Sue', 'Toppling Goliath', 'Pale Ale', 5.8, 4.1, 1000, '', 'USA', ''),
 (4, 'Schwarzbier', 'Unrelated Brewery', 'Schwarzbier', 5, 4.9, 1000, '', '', ''),
 (5, 'Lunch', 'Maine Beer Company', 'IPA', 7, 4.3, 1000, '', 'USA', ''),
])
con.commit()
`, join(dir, '.beer-data/beer.db')], { encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
process.chdir(dir);
const db = await import(join(repo, 'lib/beer-agent/beer-db/pipeline.ts'));
const provider = await import(join(repo, 'lib/beer-agent/provider.ts'));
const pipeline = await import(join(repo, 'lib/beer-agent/multi-stage-pipeline.ts'));
const labels = await import(join(repo, 'lib/skills/label-check/execute.ts'));
process.chdir(repo);
after(() => rmSync(dir, { recursive: true, force: true }));

const item = (overrides = {}) => ({ menuIndex: 7, beerName: 'LA LOVE', brewery: 'Monkish', style: 'Hazy IPA', abv: 7, ibu: null, price: 75, serving: '330ml', rawText: 'Monkish LA LOVE Hazy IPA 7% 330ml ¥75', confidence: 0.95, packagingDate: '', ...overrides });

// Real production lookup, using the actual Python/SQLite data layer in an isolated database.
test('Chinese alias lookup keeps the original query and the supplied brewery constraint', async () => {
  const [cn, en] = await db.lookupBeers(['赛博暴龙 Toppling Goliath', 'Cyber Sue Toppling Goliath']);
  assert.equal(cn.found, true);
  assert.equal(cn.query, '赛博暴龙 Toppling Goliath');
  assert.equal(cn.data.id, en.data.id);
  assert.equal(cn.data.rating, 3.86);
});

test('alias matching rejects generic fragments and unrecognized variant suffixes', async () => {
  const names = ['暴龙', '赛博', '某某黑啤', '赛博暴龙限量', '赛博暴龙 Nonexistent', '赛博暴龙 Wrong Brewery', 'Pseudo Sue Nonexistent'];
  for (const result of await db.lookupBeers(names)) assert.equal(result.found, false, result.query);
  assert.equal(db.lookupChineseBeerName('某某黑啤'), null);
  assert.equal(db.lookupChineseBeerName('暴龙'), null);
});

test('candidate assembly merges repeated rows but preserves brewery and serving identity with unique IDs', () => {
  assert.equal(typeof provider.assembleImageCandidates, 'function');
  const candidates = provider.assembleImageCandidates([
    item(), item({ beerName: '  la   love  ' }), item({ brewery: 'Another Brewery' }),
    item({ serving: '500ml', price: 95 }), item({ beerName: 'Dinner' }),
  ]);
  assert.equal(candidates.length, 4);
  assert.equal(new Set(candidates.map((c: any) => c.candidateId)).size, 4);
  assert.deepEqual(candidates.map((c: any) => c.volumeMl), [330, 330, 500, 330]);
  assert.equal(candidates[0].price, 75);
  assert.ok(candidates[0].evidence.some((e: any) => e.source === 'ocr' && e.summary.includes('LA LOVE')));
});

test('candidate assembly keeps beer names separate from style and leaves ad ratings unverified', () => {
  assert.equal(typeof provider.assembleImageCandidates, 'function');
  const candidates = provider.assembleImageCandidates([
    item({ beerName: 'Lunch', style: 'West Coast IPA', rawText: 'Lunch West Coast IPA 宣传评分4.8' }),
    item({ beerName: 'Dinner', style: 'Double IPA', rawText: 'Dinner Double IPA 宣传评分4.9' }),
  ], [{ beerName: 'Lunch', breweryName: 'Monkish', style: 'IPA', source: 'untappd', untappdScore: 4.8, verified: false }]);
  assert.deepEqual(candidates.map((c: any) => c.displayName), ['Lunch', 'Dinner']);
  assert.equal(candidates[0].untappdScore ?? null, null);
});

test('candidate assembly retains the matched beer source and never turns brewery averages into beer ratings', async () => {
  assert.equal(typeof provider.assembleImageCandidates, 'function');
  const [hit] = await db.lookupBeers(['Cyber Sue Toppling Goliath']);
  const [matched, unknown] = provider.assembleImageCandidates([
    item({ beerName: '赛博暴龙', brewery: 'Toppling Goliath' }), item({ beerName: 'Unknown Brew' }),
  ], [], [hit, null], [null, { found: true, brewery_stats: { count: 20, avg_rating: 4.3, total_ratings: 200 }, top_beers: [{ brewery: 'Monkish', name: 'Other Beer', rating: 4.5 }] }]);
  assert.equal(matched.untappdScore, 3.86);
  assert.equal(matched.untappdUrl, 'https://untappd.com/b/cyber-sue/1');
  assert.ok(matched.evidence.some((e: any) => e.summary.includes('Cyber Sue') && e.summary.includes('Toppling Goliath')));
  assert.equal(unknown.untappdScore ?? null, null);
  assert.ok(unknown.evidence.some((e: any) => e.summary.includes('非本款')));
});

test('label result identifies the visible can and keeps absent packaging date unknown', () => {
  assert.equal(typeof labels.buildLabelResult, 'function');
  const result = labels.buildLabelResult({ beerName: 'LA LOVE', brewery: 'Monkish', style: 'Hazy IPA', packagingDate: '', productionDate: '', freshnessAssessment: 'fresh', reply: '这是一罐新鲜啤酒' }, '');
  assert.match(result.reply, /LA LOVE/);
  assert.match(result.reply, /Monkish/);
  assert.match(result.reply, /日期.*(?:未|不|未知)|(?:未|不).*日期/);
  assert.doesNotMatch(result.reply, /是一罐新鲜啤酒/);
  assert.equal(result.candidates[0].displayName, 'LA LOVE');
});

test('label result only reports a date backed by visible printed text', () => {
  assert.equal(typeof labels.buildLabelResult, 'function');
  const guessed = labels.buildLabelResult({ beerName: 'Test IPA', packagingDate: '2026-09-01', visibleDateText: '' }, '');
  assert.doesNotMatch(guessed.reply, /2026-09-01/);
  const visible = labels.buildLabelResult({ beerName: 'Test IPA', packagingDate: '2026-09-01', visibleDateText: 'CANNED 2026.09.01' }, '');
  assert.match(visible.reply, /2026-09-01/);
});

test('vision extraction instructions separate proper beer names from styles and ad claims', async () => {
  assert.equal(typeof pipeline.buildVisionPrompt, 'function');
  const prompt = pipeline.buildVisionPrompt('帮我挑酒');
  assert.match(prompt, /英文.*(?:专有|酒名)|(?:专有|酒名).*英文/);
  assert.match(prompt, /style/);
  assert.match(prompt, /(?:宣传|营销).*评分/);
  assert.match(prompt, /同一.*(?:酒款|条目)/);
});

test('bare and bilingual aliases agree with English while native Chinese matches stay valid', async () => {
  const [cn, en, bilingual] = await db.lookupBeers(['赛博暴龙', 'Cyber Sue', '赛博暴龙 Cyber Sue Toppling Goliath']);
  assert.equal(cn.found, true);
  assert.equal(cn.data.id, en.data.id);
  assert.equal(bilingual.found, true);
  assert.equal(bilingual.data.rating, 3.86);
  assert.equal(db.matchesBeerIdentity('婴儿肥 高大师', { name: '婴儿肥', brewery: '高大师' }), true);
  assert.equal(db.matchesBeerIdentity('raft', { name: 'Draft', brewery: 'Other' }), false);
  assert.equal(db.matchesBeerIdentity('stamm', { name: 'Stammtisch', brewery: 'Other' }), false);
});

test('same verified beer identity deduplicates translated names', async () => {
  const [hit] = await db.lookupBeers(['Cyber Sue Toppling Goliath']);
  const candidates = provider.assembleImageCandidates([
    item({ beerName: '赛博暴龙', brewery: 'Toppling Goliath' }),
    item({ beerName: 'Cyber Sue', brewery: 'Toppling Goliath' }),
  ], [], [hit, hit]);
  assert.equal(candidates.length, 1);
});

test('verified enrichment from a different supplied brewery is not attached to a candidate', () => {
  const [candidate] = provider.assembleImageCandidates([item()], [{
    beerName: 'LA LOVE', breweryName: 'Wrong Brewery', verified: true, untappdScore: 4.9,
  }]);
  assert.equal(candidate.untappdScore ?? null, null);
});

test('duplicate source rows merge across mixed database hit availability and retain the verified score', async () => {
  const [hit] = await db.lookupBeers(['Cyber Sue Toppling Goliath']);
  const row = item({ beerName: 'Cyber Sue', brewery: 'Toppling Goliath' });
  for (const hits of [[hit, null], [null, hit]]) {
    const candidates = provider.assembleImageCandidates([row, { ...row }], [], hits);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].untappdScore, 3.86);
    assert.equal(candidates[0].candidateId, 'ocr_1');
    assert.ok(candidates[0].evidence.some((e: any) => e.source === 'untappd'));
  }
});

test('fractional pints remain separate serving offers at the same price', () => {
  const candidates = provider.assembleImageCandidates([
    item({ serving: 'pint' }), item({ serving: 'half pint' }), item({ serving: 'quarter pint' }),
  ]);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((c: any) => c.volumeMl), [473, 236.5, 118.25]);
});

test('ambiguous pint serving labels preserve distinct offers instead of guessing the same volume', () => {
  const candidates = provider.assembleImageCandidates([item({ serving: 'small pint' }), item({ serving: 'large pint' })]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c: any) => c.volumeMl), [null, null]);
});

test('a supplied brewery must match brewery field even when its words occur in the beer name', async () => {
  assert.equal(db.matchesBeerIdentity('Cyber Sue', { name: 'Cyber Sue', brewery: 'Toppling Goliath' }, 'Cyber'), false);
  const [result] = await db.lookupBeers(['Cyber Sue'], ['Cyber']);
  assert.equal(result.found, false);
  const [candidate] = provider.assembleImageCandidates([item({ beerName: 'Cyber Sue', brewery: 'Cyber' })], [{
    beerName: 'Cyber Sue', breweryName: 'Toppling Goliath', verified: true, untappdScore: 4.9,
  }]);
  assert.equal(candidate.untappdScore ?? null, null);
});

test('structured brewery constraints keep Chinese aliases disambiguated', async () => {
  const [result] = await db.lookupBeers(['赛博暴龙'], ['Toppling Goliath']);
  assert.equal(result.found, true);
  assert.equal(result.data.rating, 3.86);
});

test('rows without an identified beer name are not merged merely because their prices agree', () => {
  const candidates = provider.assembleImageCandidates([item({ beerName: '' }), item({ beerName: '' })]);
  assert.equal(candidates.length, 2);
});

test('a later rated sparse duplicate preserves earlier OCR style, ABV and IBU', async () => {
  const [hit] = await db.lookupBeers(['Cyber Sue'], ['Toppling Goliath']);
  const rows = [
    item({ beerName: 'Cyber Sue', brewery: 'Toppling Goliath', style: 'Hazy IPA', abv: 7.2, ibu: 55 }),
    item({ beerName: 'Cyber Sue', brewery: 'Toppling Goliath', style: '', abv: 0, ibu: null }),
  ];
  const [candidate] = provider.assembleImageCandidates(rows, [], [null, hit]);
  assert.equal(candidate.style, 'Hazy IPA');
  assert.equal(candidate.abv, 7.2);
  assert.equal(candidate.ibu, 55);
  assert.equal(candidate.price, 75);
  assert.equal(candidate.volumeMl, 330);
  assert.equal(candidate.untappdScore, 3.86);
  assert.equal(candidate.untappdUrl, hit.data.untappd_url);
  assert.equal(candidate.candidateId, 'ocr_1');
});

test('duplicate rows fill missing OCR facts without needing a rating change', () => {
  const [candidate] = provider.assembleImageCandidates([
    item({ style: '', abv: 0, ibu: null }), item({ style: 'Hazy IPA', abv: 7.2, ibu: 55 }),
  ]);
  assert.equal(candidate.style, 'Hazy IPA');
  assert.equal(candidate.abv, 7.2);
  assert.equal(candidate.ibu, 55);
});

test('duplicate rating records retain the first score and its matching ID and URL', async () => {
  const [hit] = await db.lookupBeers(['Cyber Sue'], ['Toppling Goliath']);
  const different = { ...hit, data: { ...hit.data, id: 99, rating: 4.5, untappd_url: 'https://untappd.com/b/cyber-sue/99' } };
  const row = item({ beerName: 'Cyber Sue', brewery: 'Toppling Goliath' });
  const [candidate] = provider.assembleImageCandidates([row, row], [], [hit, different]);
  assert.equal(candidate.untappdScore, 3.86);
  assert.equal(candidate.untappdId, '1');
  assert.equal(candidate.untappdUrl, hit.data.untappd_url);
});
