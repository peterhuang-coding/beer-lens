import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';
import type { BeerCandidate } from '../lib/beer-agent/types.ts';
const make = (id:string,price:number|null,style='IPA'):BeerCandidate => ({candidateId:id,menuIndex:Number(id),displayName:`Beer ${id}`,brewery:'Brewery',style,abv:6,price,volumeMl:330,hops:[],worthScore:0,fitScore:0,riskFlags:[],reason:'',untappdScore:4,untappdRatingCount:1000,evidence:[{source:'ocr',summary:'seen on menu',confidence:.9}]});
test('budget 50 produces no picks from a menu starting at 55, preserving the original menu',()=>{
 const r=recommendFromCandidates([make('1',55),make('2',85)],null,['maxPrice:50'],false);
 assert.equal(r.picks.topPick.candidateId,'');assert.match(r.reply,/没有.*符合/);assert.equal(r.candidates.length,2);
});
test('all positive recommendation roles satisfy price and style constraints',()=>{
 const r=recommendFromCandidates([make('1',50,'Lager'),make('2',75),make('3',90),make('4',null)],null,['maxPrice:80','IPA','不苦'],false);
 for(const pick of [r.picks.topPick,r.picks.safePick,r.picks.explorePick])if(pick.candidateId)assert.equal(pick.candidateId,'2');
 assert.equal(r.candidates[1].price,75);assert.equal(r.candidates[1].volumeMl,330);assert.equal(r.candidates[1].evidence[0].summary,'seen on menu');assert.equal(r.candidates[1].untappdRatingCount,1000);
});
test('non-beer drinks and duplicate rows do not become additional recommendations',()=>{
 const r=recommendFromCandidates([make('1',50),make('1',50),make('3',40,'Sparkling Water')],null,[],false);
 assert.equal(r.candidates.filter(c=>c.displayName==='Beer 1').length,1);assert.notEqual(r.picks.topPick.candidateId,'3');assert.ok(!r.candidates.some(c=>c.candidateId==='3'));
});

test('relaxing constraints clears prior computed warnings while retaining extraction risks',()=>{
 const candidate={...make('1',55),riskFlags:['酒名识别待确认']};
 const below=recommendFromCandidates([candidate],null,['maxPrice:50','lager'],false);
 const expanded=recommendFromCandidates(below.candidates,null,['maxPrice:90','IPA'],false);
 assert.equal(expanded.picks.topPick.candidateId,'1');
 assert.ok(expanded.candidates[0].riskFlags.includes('酒名识别待确认'));
 assert.ok(!expanded.candidates[0].riskFlags.some(s=>s.includes('50')||s.includes('lager')));
});

test('distinct offers with unresolved serving survive recommendation',()=>{
 const a={...make('1',75),displayName:'LA LOVE',volumeMl:null};
 const b={...a,candidateId:'2',evidence:[{source:'ocr' as const,summary:'large pint',confidence:.9}]};
 assert.equal(recommendFromCandidates([a,b],null,[],false).candidates.length,2);
});
