import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleImageCandidates } from '../lib/beer-agent/provider.ts';
import { matchesExactBeerIdentity } from '../lib/beer-agent/beer-db/pipeline.ts';

test('a style misfiled as name is recovered only from the same OCR block title',()=>{
 const items=[{beerName:'西海岸IPA West Coast IPA',style:'West Coast IPA',rawText:'午餐 Lunch\n西海岸IPA West Coast IPA\nABV 7.0% Untappd 4.15',abv:7},{beerName:'双倍IPA Double IPA',style:'Double IPA',rawText:'晚餐 Dinner\n双倍IPA Double IPA\nABV 8.2% Untappd 4.50',abv:8.2}];
 const result=assembleImageCandidates(items);
 assert.deepEqual(result.map(c=>c.displayName),['午餐 Lunch','晚餐 Dinner']);
 assert.ok(result.every(c=>c.untappdScore==null));
});
test('style-only source, empty source and proper names are not rewritten from unrelated prose',()=>{
 for (const rawText of ['', 'IPA\nABV 7%', 'Untappd 4.5\nMarketing message']) assert.equal(assembleImageCandidates([{beerName:'IPA',style:'IPA',rawText}])[0].displayName,'IPA');
 assert.equal(assembleImageCandidates([{beerName:'LA LOVE',style:'Double IPA',rawText:'New Release\nLA LOVE'}])[0].displayName,'LA LOVE');
});

test('a title recovered from OCR does not borrow scores from a longer, different beer name',()=>{
 const hit={query:'Lunch',found:true,data:{id:1,name:'Liquid Lunch',brewery:'Brouwerij Dockum',style:'IPA',abv:7,rating:3.37,ratings_count:1716,source:'untappd'}};
 const result=assembleImageCandidates([{beerName:'午餐 Lunch',style:'West Coast IPA',abv:7,rawText:'午餐 Lunch'}],[],[hit as any]);
 assert.equal(result[0].untappdScore??null,null);
 assert.equal(result[0].brewery,'');
});

test('printed country suffixes are separate from brewery identity, with OCR evidence unchanged',()=>{
 const item={beerName:'Lunch',brewery:'Maine | US',style:'IPA',rawText:'Lunch Maine | US',abv:7};
 const hit={query:'Lunch Maine',found:true,data:{id:1,name:'Lunch',brewery:'Maine Beer Company',style:'IPA',abv:7,rating:4.3,ratings_count:900,source:'untappd'}};
 const c=assembleImageCandidates([item],[],[hit as any])[0];
 assert.equal(c.brewery,'Maine');assert.equal(c.untappdScore,4.3);assert.equal(c.evidence[0].summary,item.rawText);
 assert.equal(assembleImageCandidates([{...item,brewery:'Maine | New Project'}])[0].brewery,'Maine | New Project');
});

test('variant aliases cannot attach ratings from the base beer or series',()=>{
 for(const [query,name] of [['双倍干投暴龙苏','Pseudo Sue'],['德米海德拉10号','DemiHydra'],['蜂巢-第6批次','La Ruche'],['果味满满34号','Just Fruit'],['甜甜圈波士顿奶油','Donut Series']]) {
  assert.equal(matchesExactBeerIdentity(query,{name,brewery:''}),false,query);
  const hit={query,found:true,data:{id:1,name,brewery:'Example',style:'IPA',abv:6,rating:4.1,ratings_count:1000,source:'untappd'}};
  assert.equal(assembleImageCandidates([{beerName:query,rawText:query,brewery:'Example'}],[],[hit as any])[0].untappdScore??null,null,query);
 }
 assert.equal(matchesExactBeerIdentity('双倍干投暴龙苏',{name:'DDH Pseudo Sue',brewery:''}),true);
});
