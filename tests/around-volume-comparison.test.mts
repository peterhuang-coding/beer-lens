import assert from 'node:assert/strict';
import test from 'node:test';
import { extractConstraints, mergeConstraints, constraintFailures } from '../lib/beer-agent/recommendation/constraints.ts';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';

// Independent acceptance cases retained as CI regressions.
const check = test;
const c=(id,menuIndex,volumeMl,price)=>({candidateId:id,menuIndex,displayName:id,brewery:'Synthetic',style:'Lager',abv:5,ibu:20,currency:'CNY',volumeMl,price,hops:[],worthScore:0,fitScore:0,riskFlags:[],reason:'',evidence:[]});
const limits=['aroundVolumeMl:300','maxPrice:80','priceGoal:unit'];
const rows=[c('large',1,425,30),c('target',2,300,75)];
const q='只比较第1号和第2号，哪款每100ml更便宜？';
check('comparison-retains-prior-serving-target',()=>{
 const r=recommendFromCandidates(rows,null,limits,false,q);
 assert.equal(r.picks.topPick.candidateId,'target');
 assert.ok(Object.values(r.picks).every(p=>!p.candidateId||p.candidateId==='target'));
});
check('comparison-shows-excluded-offer-facts-and-reason',()=>{
 const r=recommendFromCandidates(rows,null,limits,false,q);
 assert.match(r.reply,/7\.06/);assert.match(r.reply,/25\.00/);
 assert.match(r.reply,/容量|杯型/);
});
check('comparison-with-no-target-serving-clarifies',()=>{
 const r=recommendFromCandidates([c('small',1,200,50),c('large',2,425,70)],null,limits,false,q);
 assert.equal(r.picks.topPick.candidateId,'');
 assert.match(r.reply,/300/);assert.match(r.reply,/200/);assert.match(r.reply,/425/);
});
