import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';
import {extractConstraints} from '../lib/beer-agent/recommendation/constraints.ts';
import type {BeerCandidate} from '../lib/beer-agent/types.ts';
const c=(id:string,index:number,price:number|null,volumeMl:number|null):BeerCandidate=>({candidateId:id,menuIndex:index,displayName:id,brewery:'Fixture',style:'Lager',abv:5,price,volumeMl,hops:[],worthScore:0,fitScore:0,riskFlags:[],reason:'',evidence:[]});
const run=(rows:BeerCandidate[],q:string)=>recommendFromCandidates(rows,null,extractConstraints(q),false,q);
test('explicit unit price request selects cheaper offer independent of input order',()=>{
 for(const rows of [[c('A',1,60,300),c('B',7,50,500)],[c('B',7,50,500),c('A',1,60,300)]]){
 const r=run(rows,'只比较第1号和第7号，两种都接受，预算80元，哪款每100ml单位价低？');
 assert.equal(r.picks.topPick.candidateId,'B');assert.match(r.reply,/20\.00/);assert.match(r.reply,/10\.00/);assert.match(r.reply,/10元/);
 }
});
test('printed sparse menu indices constrain every pick, never array positions',()=>{
 const r=run([c('A',1,60,425),c('outside',4,20,500),c('B',7,55,425)],'只比较第1号和第7号，哪款单位价低？');
 assert.equal(r.picks.topPick.candidateId,'B');assert.ok(!Object.values(r.picks).some(p=>p.candidateId==='outside'));assert.match(r.reply,/14\.12/);assert.match(r.reply,/12\.94/);
});
test('unknown or duplicate requested menu number asks rather than picks other beers',()=>{
 for(const rows of [[c('A',1,60,300)],[c('A',1,60,300),c('B',1,50,500)]]){
 const r=run(rows,'只比较第1号和第7号，哪款性价比高？');assert.equal(r.picks.topPick.candidateId,'');assert.match(r.reply,/确认|澄清/);
 }
});
test('desired volume outranks unit savings with explicit volume preference',()=>{
 const r=run([c('A',3,85,425),{...c('B',18,85,300),abv:11.5}],'只比较第3号和第18号，两种都接受，只想喝300ml左右，比较单位价并解释取舍');
 assert.equal(r.picks.topPick.candidateId,'B');assert.match(r.reply,/28\.33/);assert.match(r.reply,/20\.00/);assert.match(r.reply,/11\.5/);
});
test('missing price or serving never gives value winner',()=>{
 for(const missing of [c('B',7,null,500),c('B',7,50,null)]){
 const r=run([c('A',1,60,300),missing],'这两款哪款性价比高？');assert.equal(r.picks.topPick.candidateId,'');assert.match(r.reply,/价格|容量/);assert.match(r.reply,/补充|提供/);
 }
});
test('budget remains hard constraint even if excluded offer cheaper per ml',()=>{
 const r=run([c('A',1,40,300),c('B',7,60,1000)],'预算50元，哪款单位价低？');assert.equal(r.picks.topPick.candidateId,'A');
});
test('all over budget gives no picks even with comparison intent',()=>{
 const r=run([c('A',1,60,300),c('B',7,55,425)],'预算50元，哪款划算？');assert.equal(r.picks.topPick.candidateId,'');assert.match(r.reply,/没有/);
});
test('ordinary recommendation presents serving and alternative delta',()=>{
 const r=run([c('A',1,60,425),c('B',7,55,425)],'预算70元，推荐一款和备选，说明价差');assert.match(r.reply,/425ml/);assert.match(r.reply,/5元/);
});
test('foreign or unknown currencies and mixed serving modes do not get a value winner',()=>{
 for(const props of [{currency:'USD'},{currency:'unknown'},{servingMode:'can'}]){
 const r=run([{...c('A',1,60,300),currency:'CNY',servingMode:'draught'},{...c('B',7,10,500),currency:'CNY',servingMode:'draught',...props}],'哪款单位价低？');assert.equal(r.picks.topPick.candidateId,'');assert.match(r.reply,/币种|消费形式/);
 }
});
