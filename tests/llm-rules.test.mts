/**
 * tests/llm-rules.test.mts
 *
 * Unit tests for the keyword rule fast-path. Verifies that common
 * Chinese beer intents land on the right skill without ever calling the
 * LLM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordRoute } from "../lib/harness/router-rules.ts";
import { registerSkill, unregisterSkill, listSkills } from "../lib/harness/router.ts";
import type { AgentReply } from "../lib/harness/types.ts";

const STUB_REPLY: AgentReply = {
  skillId: "stub",
  reply: "ok",
  candidates: [],
  picks: {
    topPick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
    safePick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
    explorePick: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
    avoidOrCaution: { candidateId: "", label: "", reason: "", worthScore: 0, fitScore: 0 },
  },
  profileSummary: "",
  errors: [],
};

function reset(): void {
  for (const s of listSkills()) unregisterSkill(s.id);
}

function stub(id: string, enabled = true): void {
  registerSkill({
    id: id as never,
    label: id,
    description: `${id} stub`,
    enabled,
    preferredHandler: "active",
    handlerFile: `stub/${id}.ts`,
    invoke: async () => STUB_REPLY,
  });
}

test('attached bottle identification enters vision before the knowledge keyword',()=>{
 reset();stub('beer_knowledge');stub('label_check');stub('menu_recommend');
 assert.equal(keywordRoute('这瓶是什么酒?',true,undefined,undefined,true)?.skill_id,'label_check');
});
test('generic image and pictured comparison both enter visual recommendation',()=>{
 reset();stub('menu_recommend');stub('label_check');stub('beer_knowledge');
 assert.equal(keywordRoute('帮我看这张图',true,undefined,undefined,true)?.skill_id,'menu_recommend');
 assert.equal(keywordRoute('Lunch 和 Dinner 哪个适合我?我不爱苦',true,undefined,undefined,true)?.skill_id,'menu_recommend');
});
test('a disabled visual skill cannot silently turn an image into text-only knowledge',()=>{
 reset();stub('label_check',false);stub('beer_knowledge');
 assert.equal(keywordRoute('这瓶是什么酒?',true,undefined,undefined,true)?.skill_id,'none');
});

test("keywordRoute: matches menu_recommend for 推荐 + IPA", () => {
  reset();
  stub("menu_recommend");
  const d = keywordRoute("推荐一款 NEIPA");
  assert.ok(d);
  assert.equal(d!.skill_id, "menu_recommend");
  assert.equal((d!.params as { style: string }).style, "NEIPA");
});

test("keywordRoute: extracts ABV numbers as max/min bounds", () => {
  reset();
  stub("menu_recommend");
  const d = keywordRoute("想要 IPA,ABV 6.5");
  assert.ok(d);
  const params = d!.params as { max_abv: number; min_abv: number };
  assert.equal(params.max_abv, 7);
  assert.equal(params.min_abv, 6);
});

test("keywordRoute: routes '什么是 NEIPA' to beer_knowledge", () => {
  reset();
  stub("beer_knowledge");
  const d = keywordRoute("什么是 NEIPA?");
  assert.ok(d);
  assert.equal(d!.skill_id, "beer_knowledge");
  assert.equal((d!.params as { question: string }).question, "什么是 NEIPA?");
});

test("keywordRoute: routes '第3个' to follow_up_filter", () => {
  reset();
  stub("follow_up_filter");
  const d = keywordRoute("第3个");
  assert.ok(d);
  assert.equal(d!.skill_id, "follow_up_filter");
  assert.equal((d!.params as { index: number }).index, 3);
});

test('spaced ordinal follow-ups retain their menu index', () => {
  reset();
  stub('follow_up_filter');
  for (const [text,index] of [['第 3 个评分',3], ['第 三 款苦度',3], ['第十一款评分',11]] as const) {
    const decision = keywordRoute(text);
    assert.equal(decision?.skill_id, 'follow_up_filter', text);
    assert.equal((decision?.params as { index: number }).index, index, text);
  }
});

test('price comparison follow-ups use the active menu', () => {
  reset();
  stub('follow_up_filter');
  stub('menu_recommend');
  for (const text of ['按单位价选', '性价比最高的呢', '最便宜的是哪个']) {
    assert.equal(keywordRoute(text)?.skill_id, 'follow_up_filter', text);
  }
});

test("keywordRoute: routes '我其实不喜欢 IPA' to memory_correction", () => {
  reset();
  stub("memory_correction");
  const d = keywordRoute("我其实不喜欢 IPA");
  assert.ok(d);
  assert.equal(d!.skill_id, "memory_correction");
});

test("keywordRoute: routes '喝过一款好喝的' to tasting_feedback (positive)", () => {
  reset();
  stub("tasting_feedback");
  const d = keywordRoute("喝过一款好喝的");
  assert.ok(d);
  assert.equal(d!.skill_id, "tasting_feedback");
  assert.equal((d!.params as { sentiment: string }).sentiment, "positive");
});

test("keywordRoute: returns null when no rule fires", () => {
  reset();
  stub("menu_recommend");
  assert.equal(keywordRoute("今天天气真好"), null);
});

test("keywordRoute: skips rules pointing at disabled skills", () => {
  reset();
  stub("menu_recommend", false); // disabled
  // The 推荐 keyword matches but the skill is disabled → must return null.
  assert.equal(keywordRoute("推荐一款 IPA"), null);
});

test("keywordRoute: matches case-insensitively on English style names", () => {
  reset();
  stub("menu_recommend");
  const d = keywordRoute("I want a stout please");
  assert.ok(d);
  assert.equal(d!.skill_id, "menu_recommend");
  assert.equal((d!.params as { style: string }).style, "STOUT");
});

test('personal history and correction actions outrank generic knowledge and feedback words',()=>{
 reset();for(const id of ['profile_query','memory_correction','beer_knowledge','tasting_feedback','menu_recommend','label_check'])stub(id as any);
 for(const text of ['我的口味偏好是什么？','我喝过哪些酒','我之前喝过哪些啤酒？帮我看看历史记录'])assert.equal(keywordRoute(text)?.skill_id,'profile_query');
 for(const text of ['重置我的记录','清空我的偏好','上次我说喜欢IPA，但其实我更喜欢西海岸IPA'])assert.equal(keywordRoute(text)?.skill_id,'memory_correction');
 for(const text of ['啤酒酵母分类','啤酒风格分类','IPA最佳饮用时机'])assert.equal(keywordRoute(text)?.skill_id,'beer_knowledge');
 assert.equal(keywordRoute('这罐啤酒哪个酒厂产')?.skill_id,'label_check');
});

test('numeric tasting statements outrank bottle/style/knowledge words without catching rating questions',()=>{
 reset();for(const id of ['profile_query','memory_correction','beer_knowledge','tasting_feedback','menu_recommend','label_check'])stub(id as any);
 for(const text of ['今天IPA4分不错','品鉴柑橘浓郁4分','10分太好喝了这瓶','0分没法喝这瓶酒','Budweiser2分工业水'])assert.equal(keywordRoute(text)?.skill_id,'tasting_feedback',text);
 assert.equal(keywordRoute('推荐评分超过4分的IPA')?.skill_id,'menu_recommend');
 assert.equal(keywordRoute('IPA评分是如何计算的')?.skill_id,'beer_knowledge');
 for(const text of ['啤酒评分4分是什么意思？','为什么这款IPA只有3分？'])assert.equal(keywordRoute(text)?.skill_id,'beer_knowledge',text);
});

test('history queries and explicit preference corrections win over style names',()=>{
 reset();for(const id of ['profile_query','memory_correction','beer_knowledge','tasting_feedback','menu_recommend','label_check'])stub(id as any);
 for(const text of ['看看历史品酒记录','评分历史查看','我不喜欢IPA'])assert.equal(keywordRoute(text)?.skill_id,'profile_query',text);
 for(const text of ['不对我更爱世涛不是IPA','清理喝过的记录','记错了更爱世涛风格','改成喜欢浑浊IPA','改成不喜欢IPA风格'])assert.equal(keywordRoute(text)?.skill_id,'memory_correction',text);
 for(const text of ['精酿啤酒能否陈年','精酿啤酒怎么保存'])assert.equal(keywordRoute(text)?.skill_id,'beer_knowledge',text);
 assert.equal(keywordRoute('推荐不苦的IPA')?.skill_id,'menu_recommend');
});

test('explicit remember-preference instructions route to persistent memory correction',()=>{
 reset();for(const id of ['memory_correction','menu_recommend','profile_query'])stub(id as any);
 for(const text of ['请记住我喜欢 IPA','记住我不喜欢世涛']) {
  assert.equal(keywordRoute(text)?.skill_id,'memory_correction',text);
 }
});

test('remaining live history, correction, identification and ambiguous requests have stable routes',()=>{
 reset();for(const id of ['profile_query','memory_correction','beer_knowledge','tasting_feedback','menu_recommend','label_check','unclear','follow_up_filter'])stub(id as any);
 const groups:Record<string,string[]>= {
  profile_query:['以前品饮历史','喝过精酿列表'],
  memory_correction:['上次推荐错了我有这款','不是这个口味是拉格'],
  label_check:['帮我识别这是什么啤酒','这是哪款风格啤酒'],
  unclear:['随便吧','说说看吧'],
  follow_up_filter:['哪个最受欢迎','哪个酒精度最高','酒精度高不高'],
 };
 for(const [skill,texts] of Object.entries(groups))for(const text of texts)assert.equal(keywordRoute(text)?.skill_id,skill,text);
});
