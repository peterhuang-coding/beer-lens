import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {groundMenuCandidates,ocrExplicitAbvEvidence} from '../lib/beer-agent/event-grounding.ts';
import {recommendFromCandidates} from '../lib/beer-agent/recommendation/decision.ts';
const records=JSON.parse(readFileSync(new URL('./fixtures/mbcb-grounding-current.json',import.meta.url),'utf8'));
const candidate=(id:number,overrides:Record<string,unknown>={})=>{
 const r=records.find((r:any)=>r.event_beer_id===id);
 return {candidateId:`synthetic-${id}`,menuIndex:id,displayName:r.name,brewery:r.brewery,style:'',abv:0,hops:[],worthScore:0,fitScore:0,riskFlags:[],reason:'',evidence:[],price:null,volumeMl:null,...overrides} as any;
};
test('publisher ABV conflict cannot satisfy a strict low-ABV request',()=>{
 const [c]=groundMenuCandidates([candidate(424)],records);
 const result=recommendFromCandidates([c],null,['maxAbv:4.6'],false,'酒精度低于4.6%');
 assert.equal(result.picks.topPick.candidateId,'');
 assert.match(c.evidence.map(e=>e.summary).join('\n'),/4.5/);
});
test('OCR versus catalog ABV conflict cannot be hidden by choosing one value',()=>{
 const [c]=groundMenuCandidates([candidate(498,{abv:5,evidence:[ocrExplicitAbvEvidence(5)]})],records);
 assert.equal(recommendFromCandidates([c],null,['maxAbv:8'],false,'低于8%').picks.topPick.candidateId,'');
});
test('malformed optional arrays fail closed without crashing image analysis',()=>{
 assert.doesNotThrow(()=>groundMenuCandidates([candidate(498)],[{...records.find((r:any)=>r.event_beer_id===498),aliases:42,issues:{bad:true}}]));
});
test('same-name recommendations identify both breweries in visible reply',()=>{
 const cs=groundMenuCandidates([candidate(96),candidate(599)],records);
 const r=recommendFromCandidates(cs,null,[],false,'推荐一杯');
 assert.match(r.reply,/Helles.*3 Sons/);assert.match(r.reply,/Helles.*Wagner Merkendorf/);
});
