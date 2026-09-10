import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShortTermMemory, updateShortTermMemory } from '../lib/beer-agent/memory/short-term.ts';

const originalCwd = process.cwd();
let temp: string;
before(async () => { temp = await mkdtemp(join(tmpdir(), 'beer-stm-')); process.chdir(temp); });
after(async () => { process.chdir(originalCwd); await rm(temp, { recursive: true, force: true }); });

async function write(userId: string, conversationId: string, name: string) {
  const candidate = { candidateId: name, menuIndex: 7, displayName: name, brewery: 'Monkish', style: 'IPA', abv: 7, price: 55, volumeMl: 330, untappdScore: 4, untappdRatingCount: 900, evidence: [{ source: 'ocr', confidence: .9, summary: 'menu line' }] };
  const pick = { candidateId: name, label: name };
  await updateShortTermMemory({ userId, conversationId, messages: [{ role: 'user', content: name }] } as never, {
    traceId: name, turnId: name, reply: name, candidates: [candidate], picks: { topPick: pick, safePick: pick, explorePick: pick, avoidOrCaution: pick }, intentResult: { intent: 'menu_recommend' },
  } as never);
}

test('a user starting another conversation does not inherit the previous menu', async () => {
  await write('alice', 'one', 'Lunch');
  assert.equal(await readShortTermMemory('two', 'alice'), null);
  await write('alice', 'two', 'Dinner');
  assert.equal((await readShortTermMemory('one', 'alice'))?.lastMenu?.candidates[0].displayName, 'Lunch');
});
test('same conversation name under different users remains isolated', async () => {
  await write('alice', 'shared-name', 'Lunch');
  await write('bob', 'shared-name', 'Dinner');
  assert.equal((await readShortTermMemory('shared-name', 'alice'))?.lastMenu?.candidates[0].displayName, 'Lunch');
});
test('complete IDs are keyed without truncation or character replacement collisions', async () => {
  for (const [a,b] of [['a/b','a?b'], ['x'.repeat(100)+'a','x'.repeat(100)+'b']]) {
    await write(a, 'collision', 'Lunch'); await write(b, 'collision', 'Dinner');
    assert.equal((await readShortTermMemory('collision', a))?.lastMenu?.candidates[0].displayName, 'Lunch');
  }
});
test('follow-up context preserves serving, original menu number and rating evidence', async () => {
  await write('metadata', 'menu', 'LA Love');
  const c = (await readShortTermMemory('menu', 'metadata'))?.lastMenu?.candidates[0] as any;
  assert.equal(c.price, 55); assert.equal(c.volumeMl, 330); assert.equal(c.menuIndex, 7);
  assert.equal(c.ratingsCount, 900); assert.equal(c.evidence[0].summary, 'menu line');
});
