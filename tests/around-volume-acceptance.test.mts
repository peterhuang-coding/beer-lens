import assert from 'node:assert/strict';
import test from 'node:test';
import { extractConstraints, mergeConstraints, constraintFailures } from '../lib/beer-agent/recommendation/constraints.ts';
import { recommendFromCandidates } from '../lib/beer-agent/recommendation/decision.ts';

// Independent acceptance cases retained as CI regressions.
const check = test;
const beer=(id,volumeMl,price)=>({candidateId:id,displayName:id,brewery:'Synthetic',style:'Lager',abv:5,ibu:20,currency:'CNY',volumeMl,price,hops:[],worthScore:0,fitScore:0,riskFlags:[],reason:'',evidence:[]});
for(const [i,text] of ['只想喝300毫升上下','容量改为约300ml','接近 300 毫升','300ml附近'].entries()){
 check('HV'+i,()=>{
  const parsed=extractConstraints(text);
  assert.ok(parsed.includes('aroundVolumeMl:300'),JSON.stringify(parsed));
  assert.ok(!parsed.includes('volumeMl:any'));
  assert.equal(constraintFailures(beer('exact',300,75),parsed).length,0);
  assert.ok(constraintFailures(beer('large',425,60),parsed).length>0);
 });
}
check('budget-update-preserves-volume',()=>{
 const merged=mergeConstraints(extractConstraints('只要约300ml，预算80元以内'),extractConstraints('预算改成60元'));
 assert.ok(merged.includes('aroundVolumeMl:300'));
 assert.ok(merged.includes('maxPrice:60'));
 assert.ok(!merged.includes('maxPrice:80'));
});
check('explicit-unlimited-clears-target',()=>{
 const merged=mergeConstraints(['aroundVolumeMl:300','maxPrice:80'],extractConstraints('不限容量'));
 assert.deepEqual(merged,['maxPrice:80','volumeMl:any']);
});
check('exact-change-clears-approx',()=>{
 const merged=mergeConstraints(['aroundVolumeMl:300','maxPrice:80'],extractConstraints('换成425毫升'));
 assert.deepEqual(merged,['maxPrice:80','volumeMl:425']);
});
check('no-exact-serving-asks-with-actual-sizes',()=>{
 const rows=[beer('small',200,50),beer('large',425,70)];
 const q='想要约300ml，按单位价挑';
 const r=recommendFromCandidates(rows,null,extractConstraints(q),false,q);
 assert.equal(r.picks.topPick.candidateId,'');
 assert.match(r.reply,/200/);assert.match(r.reply,/425/);
 assert.match(r.reply,/选择|接受|哪|确认|杯型/);
});
check('cheaper-large-never-displaces-requested-serving',()=>{
 const rows=[beer('cheap-large',425,30),beer('requested',300,75)];
 const q='只想喝300ml附近，预算80元，每100ml比较';
 const r=recommendFromCandidates(rows,null,extractConstraints(q),false,q);
 assert.equal(r.picks.topPick.candidateId,'requested');
 assert.match(r.reply,/先按|按酒单|明确标|暂按/);
});
check('volume-unknown-not-assumed',()=>{
 assert.ok(constraintFailures(beer('unknown',null,30),['aroundVolumeMl:300']).some(x=>/未知/.test(x)));
});
