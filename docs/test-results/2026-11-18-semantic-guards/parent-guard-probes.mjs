import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const [root,out]=process.argv.slice(2);
const {applyMenuEvidenceGuards:g}=await import(pathToFileURL(root+'/lib/skills/beer-knowledge/evidence-guards.ts'));
const results=[];
function probe(id,input,memory,check){const actual=g(input,memory);let status='PASS',error=null;try{check(actual)}catch(e){status='FAIL';error=e.message}results.push({id,status,input,memory,actual,error});}
const menu={lastMenu:{candidates:[{menuIndex:1,displayName:'Row One',price:60,volumeMl:425,currency:'CNY'},{menuIndex:7,displayName:'Row Seven',price:55,volumeMl:425,currency:'CNY'}]}};
probe('prefix_has_correct_arithmetic','第一款在17款中是单价最低的（14.12元/100ml）。',menu,x=>assert.match(x,/#7 Row Seven.*12\.94元/));
probe('false_claim_must_not_remain_unqualified','第一款在17款中是单价最低的（14.12元/100ml）。',menu,x=>assert.ok(!x.includes('第一款在17款中是单价最低的'),'original false assertion is still presented verbatim after the correction'));
const sourced={lastMenu:{candidates:[{menuIndex:1,displayName:'Other Beer',brewery:'Other Brewery',dossier:{brewery:{reputation:[{value:{kind:'classic',text:'producer calls THIS beer a classic'},url:'https://example.com/other',checkedAt:'2026-11-01',reviewStatus:'curated',usable:true}]}}},{menuIndex:7,displayName:'Target Beer',brewery:'Target Brewery',dossier:{brewery:{reputation:[]}}}]}};
probe('unrelated_classic_claim_does_not_authorize_target_flagship','#7 Target Beer 是 Target Brewery 的旗舰和最畅销酒款。',sourced,x=>assert.ok(x.includes('来源核对')||!x.includes('旗舰和最畅销'),'any reputation on unrelated row suppresses all source checks'));
probe('mixed_currencies_are_not_compared_as_rmb','第一款是单位价最低的。',{lastMenu:{candidates:[{menuIndex:1,displayName:'RMB Beer',price:20,volumeMl:100,currency:'CNY'},{menuIndex:2,displayName:'Dollar Beer',price:10,volumeMl:100,currency:'USD'}]}},x=>assert.ok(!x.includes('#2 Dollar Beer（10元/100ml'),'USD row is relabeled yuan and declared globally cheapest without FX'));
await writeFile(out,JSON.stringify({head:'7ba72233580802e4eae553842d8a1ef5dd7f7e1e',layer:'independent offline functional acceptance probes; no source change or API',results},null,2)+'\n');
console.log(JSON.stringify(results.map(({id,status,error})=>({id,status,error})),null,2));
process.exitCode=results.some(x=>x.status==='FAIL')?1:0;
