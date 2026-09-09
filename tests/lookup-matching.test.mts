import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function lookup(queries: string[], legacyCache = false) {
  const dir = mkdtempSync(join(tmpdir(), 'beer-lookup-match-'));
  try {
    copyFileSync('.beer-data/lookup.py', join(dir, 'lookup.py'));
    const seed = spawnSync('python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE beers (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER)')
con.execute('CREATE TABLE untappd_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER, untappd_url TEXT, country TEXT, label_image TEXT)')
con.executemany('INSERT INTO beers VALUES (?, ?, ?, ?, ?, ?, ?)', [
 (1, "Grant's Flying Pumpkin", 'Arsenal Cider House', 'Cider', 5, 4.8, 90000),
 (2, 'Pseudo Sue', 'Toppling Goliath', 'Pale Ale', 5.8, 4.1, 10000),
 (3, 'Flying Pumpkin Porter', 'Example Brewery', 'Porter', 6, 4, 100),
])
con.execute("INSERT INTO untappd_cache VALUES (4, 'Flying Kite IPA', 'Other Brewery', 'IPA', 6, 4.9, 100000, '', '', '')")
con.execute('CREATE TABLE beer_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER' + ('' if sys.argv[2] == 'legacy' else ', verified INTEGER DEFAULT 0') + ')')
con.execute("INSERT INTO beer_cache (id, name, brewery, style, abv, rating, ratings_count) VALUES (5, 'Cache Unverified', 'Cache Brewery', 'IPA', 6, 4, 100)")
con.execute("INSERT INTO beer_cache (id, name, brewery, style, abv, rating, ratings_count) VALUES (6, 'Cache Verified', 'Cache Brewery', 'IPA', 6, 4, 100)")
if sys.argv[2] != 'legacy':
 con.execute('UPDATE beer_cache SET verified = 1 WHERE id = 6')
con.commit()
`, join(dir, 'beer.db'), legacyCache ? 'legacy' : 'current'], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const response = spawnSync('python3', [join(dir, 'lookup.py'), '--batch', queries.join('|')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(response.status, 0, response.stderr);
    return JSON.parse(response.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('multiword lookup never falls back to unrelated one-word overlap', () => {
  for (const result of lookup(['Flying Fist IPA', 'Flying Fist', 'Pseudo Sue Nonexistent'])) {
    assert.equal(result.found, false);
    assert.equal(result.confidence, 'none');
  }
});
test('incomplete names and full names with brewery still find relevant beers', () => {
  const [partial, exact, brewery] = lookup(['Pseudo', 'Pseudo Sue', 'Pseudo Sue Toppling Goliath']);
  for (const result of [partial, exact, brewery]) {
    assert.equal(result.found, true);
    assert.equal(result.name, 'Pseudo Sue');
    assert.equal(result.brewery, 'Toppling Goliath');
  }
  assert.equal(exact.confidence, 'exact');
});
test('multiple supplied name words remain useful without requiring a full exact title', () => {
  const [result] = lookup(['Flying Pumpkin']);
  assert.equal(result.found, true);
  assert.match(result.name, /Flying Pumpkin/);
});

test('cache lookup preserves verified values and treats legacy missing flag as false', () => {
  const [unverified, verified] = lookup(['Cache Unverified', 'Cache Verified']);
  assert.equal(unverified.source, 'beer_cache');
  assert.equal(unverified.verified, false);
  assert.equal(verified.verified, true);
  assert.equal(lookup(['Cache Verified'], true)[0].verified, false);
});
