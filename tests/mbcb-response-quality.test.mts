import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildMenuContext,renderMenuContext} from '../lib/skills/beer-knowledge/menu-context.ts';
import {buildRecommendationReply} from '../lib/beer-agent/recommendation/reply-builder.ts';
const fail=JSON.parse(readFileSync(new URL('./fixtures/mbcb-sparse-image-response.json',import.meta.url),'utf8'));
const row=(n,name='Beer '+n,brewery='Brewery '+n)=>({candidateId:'c'+n,menuIndex:n,displayName:name,brewery,style:'Lager',abv:4.7,evidence:[],price:null,volumeMl:null});
test('sparse real-image candidate explains knownABV and unknownflavor without invented recommendation',()=>{
 const c={...fail.candidates[0],rating:null,ratingsCount:null};
 const pick={candidateId:c.candidateId,label:'',reason:'',worthScore:45,fitScore:50};
 const text=buildRecommendationReply({topPick:pick,safePick:pick,explorePick:pick,avoidOrCaution:{...pick,candidateId:''}},[c]);
 assert.match(text,/7\.5\s*%/);assert.match(text,/Mikkeller/);assert.match(text,/https:\/\/mbcb.jonpacker.com/);
 assert.match(text,/未知|不足|缺|未提供/);assert.doesNotMatch(text,/最稳|只能喝一杯|别全信我|按风格粗略分档|event_id|rating_usable|missing_ut_bid/);
});
test('event evidence appendedlast survives oldevidence cap and keeps originaldescription',()=>{
 const c=row(1);c.evidence=[...Array.from({length:3},()=>({source:'ocr',summary:'old snippet'})),{source:'venue_site',summary:'MBCB https://mbcb.jonpacker.com/latest.json '+'.'.repeat(260)+' Original description: white grape, passionfruit and grapefruit.'}];
 const text=renderMenuContext(buildMenuContext({lastMenu:{candidates:[c]}},'介绍一下第1款'));
 assert.match(text,/white grape, passionfruit and grapefruit/);assert.match(text,/mbcb.jonpacker.com/);
});
test('explicitrow9 is includedinsidebounded8facts',()=>{
 const rows=Array.from({length:12},(_,i)=>row(i+1));rows[8].abv=7.5;
 const ctx=buildMenuContext({lastMenu:{candidates:rows}},'介绍一下 #9');
 assert.ok(ctx.shownCandidates.some(c=>c.menuIndex===9));assert.ok(ctx.shownCandidates.length<=8);
 assert.match(renderMenuContext(ctx),/ABV 7.5%/);
});
test('intentionaltwoHellescomparison isnot an unresolvedsinglebeer',()=>{
 const rows=[row(96,'Helles','3 Sons'),row(599,'Helles','Wagner Merkendorf')];
 const memory={lastMenu:{candidates:rows}};
 const ctx=buildMenuContext(memory,'这两款 Helles 有什么区别？');
 assert.equal(ctx.reference.kind,'menu');assert.equal(ctx.reference.beers.length,2);
 assert.doesNotMatch(renderMenuContext(ctx),/必须先反问/);
 assert.equal(buildMenuContext(memory,'Helles 是什么？').reference.kind,'ambiguous');
});
