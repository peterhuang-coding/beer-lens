import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShortTermMemory, updateShortTermMemory } from '../lib/beer-agent/memory/short-term.ts';
import { getCorrections } from '../lib/beer-agent/memory/corrections.ts';
import { getProfileMemory } from '../lib/beer-agent/memory/profile.ts';
import { execute as executeRecommendation } from '../lib/skills/recommend/execute.ts';
import { execute as executeMemoryCorrection } from '../lib/skills/memory-correction/execute.ts';

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

async function writeMenu(userId: string, conversationId: string) {
  const candidates = [
    { candidateId: 'first', menuIndex: 1, displayName: 'First Lager', brewery: 'Brewery', style: 'Lager', abv: 5, price: 45, volumeMl: 330, untappdScore: 4, untappdRatingCount: 900, evidence: [{ source: 'manual_user_input', confidence: 1, summary: 'first row' }] },
    { candidateId: 'second', menuIndex: 2, displayName: 'Second IPA', brewery: 'Brewery', style: 'IPA', abv: 6, price: 65, volumeMl: 330, untappdScore: 4, untappdRatingCount: 900, evidence: [{ source: 'manual_user_input', confidence: 1, summary: 'second row' }] },
  ];
  const pick = { candidateId: 'first', label: 'First Lager' };
  await updateShortTermMemory({ userId, conversationId, messages: [{ role: 'user', content: '酒单：\nFirst Lager ¥45\nSecond IPA ¥65' }] } as never, {
    traceId: 'menu-trace', turnId: 'menu-turn', reply: 'ok', candidates,
    picks: { topPick: pick, safePick: pick, explorePick: pick, avoidOrCaution: pick },
    intentResult: { intent: 'menu_recommend' },
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

test('a spaced ordinal follow-up narrows the remembered menu to that item', async () => {
  const userId = 'ordinal-user'; const conversationId = 'ordinal-menu';
  await writeMenu(userId, conversationId);
  const result = await executeRecommendation({
    userId, conversationId, traceId: 'follow-up-trace', hasImage: false,
    lastUserText: '第 2 款评分', messages: [{ role: 'user', content: '第 2 款评分' }], channel: 'web',
  }, {});
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidateId, 'second');
  assert.equal(result.picks.topPick.candidateId, 'second');
  await updateShortTermMemory({ userId, conversationId, messages: [{ role: 'user', content: '第 2 款评分' }] } as never, {
    traceId: 'follow-up-trace', turnId: 'follow-up-turn', reply: result.reply, candidates: result.candidates,
    picks: result.picks, intentResult: { intent: 'follow_up_filter' },
  } as never);
  const afterFollowUp = await readShortTermMemory(conversationId, userId);
  assert.equal(afterFollowUp?.lastMenu?.candidates.length, 2);
  assert.deepEqual(afterFollowUp?.lastMenu?.candidates.map(candidate=>candidate.candidateId), ['first','second']);
});

test('a compound Chinese ordinal follows the printed menu index', async () => {
  const userId = 'compound-ordinal-user'; const conversationId = 'compound-ordinal-menu';
  const candidates = [
    { candidateId: 'tenth', menuIndex: 10, displayName: 'Tenth Lager', brewery: 'Brewery', style: 'Lager', abv: 5, price: 45, volumeMl: 330, untappdScore: 4, untappdRatingCount: 900, evidence: [{ source: 'manual_user_input', confidence: 1, summary: 'tenth row' }] },
    { candidateId: 'eleventh', menuIndex: 11, displayName: 'Eleventh IPA', brewery: 'Brewery', style: 'IPA', abv: 6, price: 65, volumeMl: 330, untappdScore: 4, untappdRatingCount: 900, evidence: [{ source: 'manual_user_input', confidence: 1, summary: 'eleventh row' }] },
  ];
  const pick = { candidateId: 'tenth', label: 'Tenth Lager' };
  await updateShortTermMemory({ userId, conversationId, messages: [{ role: 'user', content: '酒单：\n10. Tenth Lager ¥45\n11. Eleventh IPA ¥65' }] } as never, {
    traceId: 'compound-menu-trace', turnId: 'compound-menu-turn', reply: 'ok', candidates,
    picks: { topPick: pick, safePick: pick, explorePick: pick, avoidOrCaution: pick },
    intentResult: { intent: 'menu_recommend' },
  } as never);

  const result = await executeRecommendation({
    userId, conversationId, traceId: 'compound-follow-up-trace', hasImage: false,
    lastUserText: '第十一款评分', messages: [{ role: 'user', content: '第十一款评分' }], channel: 'web',
  }, {});
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidateId, 'eleventh');
});

test('a failed replacement image preserves the previous complete menu without applying new-menu constraints', async () => {
  const userId = 'failed-image-user'; const conversationId = 'failed-image-menu';
  await writeMenu(userId, conversationId);
  await updateShortTermMemory({ userId, conversationId, image: { dataUrl: 'data:image/png;base64,broken' }, messages: [{ role: 'user', content: '新酒单，预算80元' }] } as never, {
    traceId: 'failed-image-trace', turnId: 'failed-image-turn', reply: '识别失败', candidates: [],
    picks: { topPick: { candidateId: '', label: '' }, safePick: { candidateId: '', label: '' }, explorePick: { candidateId: '', label: '' }, avoidOrCaution: { candidateId: '', label: '' } },
    intentResult: { intent: 'menu_recommend' },
  } as never);
  const memory = await readShortTermMemory(conversationId, userId);
  assert.deepEqual(memory?.lastMenu?.candidates.map(candidate=>candidate.candidateId), ['first','second']);
  assert.ok(!memory?.currentConstraints?.includes('maxPrice:80'));
});

test('an ambiguous ordinal asks whether the user means menu or recommendation order', async () => {
  const userId = 'ambiguous-ordinal-user'; const conversationId = 'ambiguous-ordinal-menu';
  const candidates = [
    { candidateId: 'first', menuIndex: 1, displayName: 'First Lager', brewery: 'Brewery', style: 'Lager', abv: 5, price: 45, volumeMl: 330, untappdScore: 3.5, untappdRatingCount: 100, evidence: [{ source: 'manual_user_input', confidence: 1, summary: 'first row' }] },
    { candidateId: 'second', menuIndex: 2, displayName: 'Second IPA', brewery: 'Brewery', style: 'IPA', abv: 6, price: 65, volumeMl: 330, untappdScore: 4.5, untappdRatingCount: 1000, evidence: [{ source: 'manual_user_input', confidence: 1, summary: 'second row' }] },
  ];
  await updateShortTermMemory({ userId, conversationId, messages: [{ role: 'user', content: '酒单：\n1. First Lager ¥45\n2. Second IPA ¥65' }] } as never, {
    traceId: 'ambiguous-menu-trace', turnId: 'ambiguous-menu-turn', reply: 'ok', candidates,
    picks: { topPick: { candidateId: 'second', label: 'Second IPA' }, safePick: { candidateId: 'first', label: 'First Lager' }, explorePick: { candidateId: 'second', label: 'Second IPA' }, avoidOrCaution: { candidateId: '', label: '' } },
    intentResult: { intent: 'menu_recommend' },
  } as never);
  const ambiguous = await executeRecommendation({
    userId, conversationId, traceId: 'ambiguous-follow-up', hasImage: false,
    lastUserText: '第 2 款呢', messages: [{ role: 'user', content: '第 2 款呢' }], channel: 'web',
  }, {});
  assert.match(ambiguous.reply, /菜单第 2 款.*推荐列表第 2 款/);
  assert.equal(ambiguous.picks.topPick.candidateId, '');
  const explicit = await executeRecommendation({
    userId, conversationId, traceId: 'explicit-follow-up', hasImage: false,
    lastUserText: '推荐列表的第 2 款呢', messages: [{ role: 'user', content: '推荐列表的第 2 款呢' }], channel: 'web',
  }, {});
  assert.equal(explicit.candidates.length, 1);
  assert.equal(explicit.candidates[0].candidateId, 'first');
});

test('an explicit remember-preference request persists the correction and rebuilt profile', async () => {
  const userId = 'preference-user';
  const result = await executeMemoryCorrection({
    userId, conversationId: 'preference-menu', traceId: 'preference-trace', hasImage: false,
    lastUserText: '请记住我喜欢 IPA', messages: [{ role: 'user', content: '请记住我喜欢 IPA' }], channel: 'web',
  }, {});
  const corrections = await getCorrections(userId);
  const profile = await getProfileMemory(userId);
  assert.equal(corrections.corrections.at(-1)?.action, 'add_preferred_style');
  assert.equal(corrections.corrections.at(-1)?.targetValue, 'IPA');
  assert.ok(profile.preferredStyles.some((style) => style.value === 'IPA'));
  assert.equal(result.data?.updatedProfile, true);
});
