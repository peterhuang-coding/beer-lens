import './fixtures/menu-file-cache-stubs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const first = await mkdtemp(path.join(tmpdir(), 'beer-menu-cache-a-'));
const second = await mkdtemp(path.join(tmpdir(), 'beer-menu-cache-b-'));
const fixedTime = new Date('2026-01-01T00:00:00Z');
const reads: string[] = [];
(globalThis as any).__beerMenuFileReads = reads;

function eventRecord(name: string) {
  return {
    event_id: 'mbcb-2026-red', event_beer_id: 1, name, name_zh: null,
    brewery: 'Cache Brewery', brewery_zh: null, sessions: ['red'], style: 'IPA', abv: 6,
    description: null, untappd_id: null, rating_raw: null, rating_count: null,
    rating_usable: false, source_url: 'https://example.com/event', retrieved_at: '2026-10-01',
    issues: [], field_disagreements: {}, aliases: [],
  };
}

function supplementEntry(id: string, name: string, menuIndex: number) {
  return {
    id, menu_index: menuIndex, menu_name: name, name_zh: '', brewery: 'Cache Brewery',
    brewery_aliases: [], aliases: [], identity_status: 'confirmed', canonical_name: null,
    style: 'IPA', abv: 6, description_zh: '',
    observation: { abv: null, price: null, volume_ml: null, currency: 'CNY', observed_at: '2026-10-20', source: 'menu_transcription' },
    sources: [{ url: 'https://example.com/menu', kind: 'brewery', access: 'web_index_or_cache', checked_at: '2026-10-20', fields: ['style'] }],
    issues: [], field_disagreements: {},
  };
}

async function writeTree(root: string, eventName: string, supplementName: string) {
  await mkdir(path.join(root, 'data', 'events'), { recursive: true });
  await mkdir(path.join(root, 'data', 'menus'), { recursive: true });
  const eventPath = path.join(root, 'data', 'events', 'mbcb-2026-red.json');
  await writeFile(eventPath, JSON.stringify([eventRecord(eventName)]));
  await utimes(eventPath, fixedTime, fixedTime);
  const base = { version: 1, menu_id: 'fixture', entries: [supplementEntry('base', supplementName, 1)] };
  const additions = { version: 1, menu_id: 'fixture', entries: [supplementEntry('addition', `${supplementName} Two`, 2)] };
  await writeFile(path.join(root, 'data', 'menus', 'elnido-2026-10.json'), JSON.stringify(base));
  await writeFile(path.join(root, 'data', 'menus', 'elnido-2026-10-additions.json'), JSON.stringify(additions));
}

await writeTree(first, 'Alpha Ale', 'Alpha Supplement');
await writeTree(second, 'Other Beer', 'Other Supplement');
process.chdir(first);
const eventMod = await import('../lib/beer-agent/event-grounding.ts');
const supplementsMod = await import('../lib/beer-agent/menu-supplements.ts');

test('fixed menu files are cached by absolute path and file signature', async (t) => {
  t.after(async () => {
    process.chdir(originalCwd);
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  reads.length = 0;
  const firstEvent = await eventMod.readEventCatalog();
  const firstSupplements = await supplementsMod.readMenuSupplements();
  assert.deepEqual(await eventMod.readEventCatalog(), firstEvent);
  assert.deepEqual(await supplementsMod.readMenuSupplements(), firstSupplements);
  assert.equal(firstEvent[0].name, 'Alpha Ale');
  assert.equal(firstSupplements.length, 2);
  assert.equal(reads.length, 3, 'second identical reads reuse the three parsed files');

  // Same path, byte length and restored mtime: ctime must still invalidate.
  const eventPath = path.join(first, 'data', 'events', 'mbcb-2026-red.json');
  await writeFile(eventPath, JSON.stringify([eventRecord('Bravo Ale')]));
  await utimes(eventPath, fixedTime, fixedTime);
  assert.equal((await eventMod.readEventCatalog())[0].name, 'Bravo Ale');
  assert.equal(reads.length, 4);

  process.chdir(second);
  assert.equal((await eventMod.readEventCatalog())[0].name, 'Other Beer');
  assert.equal((await supplementsMod.readMenuSupplements())[0].menu_name, 'Other Supplement');
  assert.equal(reads.length, 7, 'same relative paths in another cwd cannot reuse old data');

  await rm(path.join(second, 'data', 'events', 'mbcb-2026-red.json'));
  assert.deepEqual(await eventMod.readEventCatalog(), [], 'deletion fails soft, never stale');
});
