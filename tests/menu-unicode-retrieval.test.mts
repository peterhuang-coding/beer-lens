import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChineseAlias } from '../lib/beer-agent/beer-db/aliases.ts';

// Synthetic, temporary SQLite only — never touches a production database.
// Mirrors the El Nido menu identities: one confirmed Cyrillic title
// (Белоглазка / 白眼, Sergacore) plus variant/brewery decoys.
function lookupBatch(
  queries: string[],
  extras: { beers?: unknown[][]; untappd?: unknown[][] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'beer-menu-unicode-'));
  try {
    copyFileSync('.beer-data/lookup.py', join(dir, 'lookup.py'));
    const seed = spawnSync('python3', ['-c', `
import sqlite3, sys, json
con = sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE beers (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER)')
con.execute('CREATE TABLE untappd_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER, untappd_url TEXT, country TEXT, label_image TEXT)')
con.execute('CREATE TABLE beer_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER, verified INTEGER DEFAULT 0)')
con.executemany('INSERT INTO beers VALUES (?,?,?,?,?,?,?)', [
  (1, 'Белоглазка', 'Sergacore', 'Wild Ale', 7.0, 4.2, 100),
  (2, 'Double Blueberry Marshmallow Shake', 'Great Notion', 'Sour Ale', 8.0, 4.4, 5000),
  (3, 'Lunch', 'Maine Beer Company', 'IPA', 7.0, 4.3, 20000),
] + json.loads(sys.argv[2]))
con.executemany('INSERT INTO untappd_cache VALUES (?,?,?,?,?,?,?,?,?,?)', [
  (4, 'Double Blueberry Shake', 'Other Brewery', 'Sour Ale', 7.5, 4.6, 90000, '', '', ''),
  (5, 'Dutch IPA - Lemons for Lunch', 'Emperor Kees', 'IPA', 6.0, 4.0, 500, '', '', ''),
] + json.loads(sys.argv[3]))
con.commit()
`, join(dir, 'beer.db'), JSON.stringify(extras.beers ?? []), JSON.stringify(extras.untappd ?? [])], {
      encoding: 'utf8',
      timeout: 10000,
    });
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

test('Cyrillic title is recalled in original, lowercase and uppercase casing', () => {
  for (const result of lookupBatch(['Белоглазка', 'белоглазка', 'БЕЛОГЛАЗКА'])) {
    assert.equal(result.found, true);
    assert.equal(result.name, 'Белоглазка');
    assert.equal(result.brewery, 'Sergacore');
    assert.equal(result.confidence, 'exact');
  }
});

test('brewery-qualified Cyrillic name resolves and a wrong brewery never substitutes', () => {
  const [qualified, wrongBrewery] = lookupBatch([
    'Белоглазка Sergacore',
    'Белоглазка Mystery Brewing',
  ]);
  assert.equal(qualified.found, true);
  assert.equal(qualified.name, 'Белоглазка');
  assert.equal(qualified.brewery, 'Sergacore');
  assert.equal(wrongBrewery.found, false);
  assert.equal(wrongBrewery.confidence, 'none');
});

test('Cyrillic bare name across breweries/ABVs stays ambiguous; qualification picks one', () => {
  const results = lookupBatch(
    ['Белоглазка', 'Белоглазка Sergacore', 'Белоглазка Rival Brewery'],
    { beers: [[10, 'Белоглазка', 'Rival Brewery', 'Wild Ale', 8.5, 4.0, 50]] },
  );
  assert.equal(results[0].found, false);
  assert.equal(results[0].confidence, 'none');
  assert.equal(results[1].found, true);
  assert.equal(results[1].brewery, 'Sergacore');
  assert.equal(results[2].found, true);
  assert.equal(results[2].brewery, 'Rival Brewery');
});

test('full variant name never collapses onto the shorter sibling variant', () => {
  const [full, fullAtWrongBrewery] = lookupBatch([
    'Double Blueberry Marshmallow Shake',
    'Double Blueberry Marshmallow Shake Other Brewery',
  ]);
  assert.equal(full.found, true);
  assert.equal(full.name, 'Double Blueberry Marshmallow Shake');
  assert.equal(full.brewery, 'Great Notion');
  // Asking for the decoy brewery must not serve the Great Notion beer.
  assert.equal(fullAtWrongBrewery.found, false);
  assert.equal(fullAtWrongBrewery.confidence, 'none');
});

test('exact title still beats a higher-traffic fuzzy title-only hit', () => {
  const [lunch] = lookupBatch(['Lunch']);
  assert.equal(lunch.found, true);
  assert.equal(lunch.name, 'Lunch');
  assert.equal(lunch.brewery, 'Maine Beer Company');
});

test('Chinese alias 白眼 resolves to the exact Cyrillic title end to end', () => {
  const resolved = resolveChineseAlias('白眼');
  assert.ok(resolved);
  assert.equal(resolved.name, 'Белоглазка');
  assert.equal(resolved.query, 'Белоглазка');
  assert.equal(resolved.exact, true);

  const [hit] = lookupBatch([resolved.query]);
  assert.equal(hit.found, true);
  assert.equal(hit.name, 'Белоглазка');
  assert.equal(hit.brewery, 'Sergacore');
});

const MENU_ALIASES: ReadonlyArray<[string, string]> = [
  ['风之丘', 'Windy Hill'],
  ['触碰酒花', 'Kiwi Fingers'],
  ['胜利绕场', 'Victory Lap'],
  ['奇思妙想', 'Good Idea'],
  ['迷魂少女', 'Girls Gone Hazy'],
  ['精益求精', 'Pils For Skills'],
  ['李尔王英式苦啤', 'King Lear'],
  ['收割者', 'Green Reaper'],
  ['京都狂爱症', 'K-philia'],
  ['午餐自由', 'Free Lunch'],
  ['白眼', 'Белоглазка'],
  ['记住小伙伴们第二名没有馅饼', 'Remember Boys, No Pie for Second Place'],
  ['双重蓝色甜蜜摇滚', 'Double Blueberry Marshmallow Shake'],
  ['奶奶的斐济果', "Grandma's Feijoa"],
  ['甄选2号', 'The Cut: Laroda Plum'],
  ['归还一切（过四桶）', 'Reclaim Me 2026'],
];

test('every supplied menu Chinese name maps to its exact printed English title', () => {
  for (const [zh, en] of MENU_ALIASES) {
    const resolved = resolveChineseAlias(zh);
    assert.ok(resolved, `missing alias for ${zh}`);
    assert.equal(resolved.name, en);
    assert.equal(resolved.query, en);
    assert.equal(resolved.exact, true);
  }
});

test('aliases never collapse variants, preserves, or vintages onto different beers', () => {
  const shake = resolveChineseAlias('双重蓝色甜蜜摇滚');
  assert.equal(shake?.name, 'Double Blueberry Marshmallow Shake');
  assert.notEqual(shake?.name, 'Double Blueberry Shake');

  const cut = resolveChineseAlias('甄选2号');
  assert.equal(cut?.name, 'The Cut: Laroda Plum');
  assert.notEqual(cut?.name, 'Backdrop Preserves');

  const reclaim = resolveChineseAlias('归还一切（过四桶）');
  assert.equal(reclaim?.name, 'Reclaim Me 2026');
  assert.match(reclaim?.name ?? '', /2026/);
  assert.notEqual(reclaim?.name, 'Reclaim Me');

  // Existing alias and longer menu alias must not shadow each other.
  assert.equal(resolveChineseAlias('午餐')?.name, 'Lunch');
  assert.equal(resolveChineseAlias('午餐自由')?.name, 'Free Lunch');
});

test('source-confirmed Cyrillic tap #7 aliases the base title, never the 2.0 variant', () => {
  assert.equal(resolveChineseAlias('伊完内奇')?.name, 'Иваныч');
  assert.notEqual(resolveChineseAlias('伊完内奇')?.name, 'Иваныч 2.0');
});
