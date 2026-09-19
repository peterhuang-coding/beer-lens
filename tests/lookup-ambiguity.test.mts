import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function lookup(queries: string[], legacyCache = false) {
  const dir = mkdtempSync(join(tmpdir(), 'beer-lookup-ambiguity-'));
  try {
    copyFileSync('.beer-data/lookup.py', join(dir, 'lookup.py'));
    const seed = spawnSync('python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE beers (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER)')
con.execute('CREATE TABLE untappd_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER, untappd_url TEXT, country TEXT, label_image TEXT)')
con.executemany('INSERT INTO beers VALUES (?, ?, ?, ?, ?, ?, ?)', [
  (1, 'Pseudo Sue', 'Toppling Goliath', 'Pale Ale', 5.8, 4.1, 10000),
  (2, 'Pseudo Sue', 'Rival Brewing', 'Pale Ale', 6.2, 4.6, 90000),
  (3, 'Same Name', 'Same Brewery', 'IPA', 6, 4.0, 100),
  (4, 'Same Name', 'Same Brewery', 'IPA', 7, 4.2, 200),
  (5, 'Empty Brewery', 'Known Brewery', 'Stout', 8, 4.3, 300),
])
con.executemany('INSERT INTO untappd_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
  (6, 'Empty Brewery', '', 'Stout', 8, 4.4, 400, '', '', ''),
  (7, 'Cache Ambiguous', 'Verified Brewing', 'IPA', 6, 4.2, 100, '', '', ''),
])
con.execute('CREATE TABLE beer_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER' + ('' if sys.argv[2] == 'legacy' else ', verified INTEGER DEFAULT 0') + ')')
con.executemany('INSERT INTO beer_cache (id, name, brewery, style, abv, rating, ratings_count) VALUES (?, ?, ?, ?, ?, ?, ?)', [
  (8, 'Pseudo Sue', 'Toppling Goliath', 'Pale Ale', 5.8, 4.1, 10000),
  (9, 'Cache Ambiguous', 'Other Brewing', 'IPA', 6.1, 4.1, 50),
  (10, 'Verified Legacy Flag', 'Legacy Brewery', 'Lager', 5, 3.9, 20),
])
if sys.argv[2] != 'legacy':
  con.execute('UPDATE beer_cache SET verified = 1 WHERE id = 8')
con.execute("INSERT INTO beer_cache (id,name,brewery,style,abv,rating,ratings_count) VALUES (11,'Safe Duplicate','Same Brewery','Lager',5,4,25)")
con.execute("INSERT INTO untappd_cache VALUES (12,'Safe Duplicate','Same Brewery','Lager',5,3.9,100,'','','')")
con.executemany('INSERT INTO beers VALUES (?,?,?,?,?,?,?)', [(100+i,'Crowded Name','Common Brewery','IPA',6,4,1000) for i in range(55)] + [(200,'Crowded Name','Rare Brewery','IPA',6,3,1)])
con.execute('INSERT INTO beers VALUES (201,?,?,?,?,?,?)', ("Brewer's Ale",'First Brewery','Ale',5,4,10))
con.execute("INSERT INTO untappd_cache VALUES (202,'Brewers Ale','Other Brewery','Ale',5,4,10,'','','')")
if sys.argv[2] != 'legacy':
  con.execute('UPDATE beer_cache SET verified=1 WHERE id=11')
con.commit()
`, join(dir, 'beer.db'), legacyCache ? 'legacy' : 'current'], { encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);

    const response = spawnSync('python3', [join(dir, 'lookup.py'), '--batch', queries.join('|')], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(response.status, 0, response.stderr);
    return JSON.parse(response.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bare exact name shared by distinct breweries is ambiguous and has no winner', () => {
  const [result] = lookup(['Pseudo Sue']);
  assert.equal(result.found, false);
  assert.equal(result.confidence, 'none');
  assert.equal(result.total_found, undefined);
});

test('brewery-qualified exact names still resolve to the requested brewery', () => {
  const [toppling, rival] = lookup([
    'Pseudo Sue Toppling Goliath',
    'Pseudo Sue Rival Brewing',
  ]);

  assert.equal(toppling.found, true);
  assert.equal(toppling.name, 'Pseudo Sue');
  assert.equal(toppling.brewery, 'Toppling Goliath');
  assert.equal(toppling.source, 'beer_cache');
  assert.equal(toppling.verified, true);
  assert.equal(toppling.confidence, 'high');

  assert.equal(rival.found, true);
  assert.equal(rival.name, 'Pseudo Sue');
  assert.equal(rival.brewery, 'Rival Brewing');
  assert.equal(rival.source, 'ratebeer');
  assert.equal(rival.confidence, 'high');
});

test('duplicate same name and same brewery are handled conservatively', () => {
  const [result] = lookup(['Same Name']);
  assert.equal(result.found, false);
  assert.equal(result.confidence, 'none');
});

test('empty brewery cannot be used as disambiguating evidence', () => {
  const [result] = lookup(['Empty Brewery']);
  assert.equal(result.found, false);
  assert.equal(result.confidence, 'none');
});

test('unverified beer_cache ambiguity does not override another source and verified metadata is preserved', () => {
  const ambiguousBare = lookup(['Cache Ambiguous'])[0];
  assert.equal(ambiguousBare.found, false);
  assert.equal(ambiguousBare.confidence, 'none');

  const [qualifiedVerified, qualifiedOther, legacy] = lookup([
    'Cache Ambiguous Verified Brewing',
    'Cache Ambiguous Other Brewing',
    'Verified Legacy Flag',
  ]);
  assert.equal(qualifiedVerified.found, true);
  assert.equal(qualifiedVerified.brewery, 'Verified Brewing');
  assert.equal(qualifiedVerified.source, 'untappd');

  assert.equal(qualifiedOther.found, true);
  assert.equal(qualifiedOther.brewery, 'Other Brewing');
  assert.equal(qualifiedOther.source, 'beer_cache');
  assert.equal(qualifiedOther.verified, false);

  assert.equal(legacy.found, true);
  assert.equal(legacy.source, 'beer_cache');
  assert.equal(legacy.verified, false);
  assert.equal(lookup(['Verified Legacy Flag Legacy Brewery'], true)[0].verified, false);
});

test('same identity across sources preserves cache provenance and verification', () => {
 const [r]=lookup(['Safe Duplicate']);
 assert.equal(r.found,true);assert.equal(r.source,'beer_cache');assert.equal(r.verified,true);
 assert.equal(lookup(['Safe Duplicate'],true)[0].verified,false);
});
test('ambiguity is not hidden beyond a popularity shortlist', () => {
 const [r]=lookup(['Crowded Name']);assert.equal(r.found,false);
});
test('apostrophe normalization does not select one of two breweries', () => {
 for(const r of lookup(["Brewer's Ale",'Brewers Ale'])) assert.equal(r.found,false);
});
