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

test('not-bitter request prefers the lower-IBU beer among otherwise equal IPA candidates',()=>{
 const highIbu={...make('1',60),displayName:'High IBU IPA',ibu:80};
 const lowIbu={...make('2',60),displayName:'Low IBU IPA',ibu:20};
 const result=recommendFromCandidates([highIbu,lowIbu],null,['不苦'],false);
 assert.equal(result.picks.topPick.candidateId,'2');
 assert.equal(result.candidates.find(candidate=>candidate.candidateId==='2')?.fitScore,result.picks.topPick.fitScore);
});

test('explicit unit-price request selects the lowest comparable unit price',()=>{
 const small={...make('1',60,'Lager'),displayName:'Small Lager',volumeMl:300};
 const large={...make('2',50,'Lager'),displayName:'Large Lager',volumeMl:500};
 const result=recommendFromCandidates([small,large],null,['maxPrice:80','priceGoal:unit'],false);
 assert.equal(result.picks.topPick.candidateId,'2');
 assert.match(result.reply,/¥50 \/ 500ml（约 ¥10\/100ml）/);
 assert.match(result.reply,/价量对比/);
 assert.match(result.reply,/多花 ¥10/);
});

test('lower unit price never overrides a hard total-price budget',()=>{
 const within={...make('1',48,'Lager'),volumeMl:330};
 const over={...make('2',60,'Lager'),volumeMl:500};
 const result=recommendFromCandidates([within,over],null,['maxPrice:50','priceGoal:unit'],false);
 assert.equal(result.picks.topPick.candidateId,'1');
 assert.ok(result.candidates.find(candidate=>candidate.candidateId==='2')?.riskFlags.some(flag=>flag.includes('预算')));
});
