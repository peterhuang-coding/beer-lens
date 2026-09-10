import test from 'node:test';
import assert from 'node:assert/strict';
import * as benchmark from '../scripts/run-image-benchmark.mjs';

const candidate = (name: string, id: string, extra = {}) => ({ candidateId: id, displayName: name, brewery: 'Monkish', style: 'IPA', price: 85, volumeMl: 425, abv: 7.2, evidence: [{ source: 'ocr', summary: name }], ...extra });
const response = (candidates: any[], extra = {}) => ({ status: 200, data: { intentResult: { intent: 'menu_recommend' }, reply: '这是推荐。', candidates, picks: { topPick: { candidateId: candidates[0]?.candidateId ?? '' } }, ...extra }, events: [], parseError: null });

function evaluate(id: string, wire: any, context = {}) {
  assert.equal(typeof benchmark.evaluateResponse, 'function');
  return benchmark.evaluateResponse(id, '/api/agent', wire, context);
}

test('image benchmark rejects legacy mode-only inference and empty successful replies', () => {
  const result = evaluate('tap-menu', response([], { intentResult: undefined, mode: 'recommend' }));
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((c: any) => c.name === 'actualIntent' && !c.pass));
  assert.ok(result.checks.some((c: any) => c.name === 'candidateCount' && !c.pass));
});

test('marketing benchmark requires Lunch and Dinner as distinct named entities', () => {
  const result = evaluate('marketing', response([candidate('西海岸IPA','1'), candidate('双倍IPA','2')]));
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((c: any) => c.name === 'entity:Lunch' && !c.pass));
  assert.ok(result.checks.some((c: any) => c.name === 'entity:Dinner' && !c.pass));
});

test('El Nido benchmark rejects non-IPA hard picks even if the menu contains IPA', () => {
  const rows = Array.from({length:15},(_,i)=>candidate(`Beer ${i}`,String(i)));
  rows[0] = candidate('LA LOVE','0'); rows[1]=candidate('Lunch','1',{brewery:'Maine Beer Company'});
  rows[2]=candidate('Rice Lager','2',{style:'Rice Lager'});
  const result = evaluate('el-nido', response(rows,{picks:{topPick:{candidateId:'2'}}}));
  assert.equal(result.passed,false);
  assert.ok(result.checks.some((c: any)=>c.name==='ipaHardPicks'&&!c.pass));
});

test('budget followup cannot pass by returning zero candidates or retaining an over-budget pick', () => {
  const source = [candidate('Cyber Sue','1')];
  for(const rows of [[],source]){
    const result=evaluate('budget-followup',response(rows,{intentResult:{intent:'follow_up_filter'},reply:'没有符合预算的酒',picks:{topPick:{candidateId:'1'}}}),{baseline:response(source),cookieSent:'beer_lens_user_id=test'});
    assert.equal(result.passed,false);
    assert.ok(result.checks.some((c:any)=>c.name==='noBudgetPicks'&&!c.pass));
  }
});

test('can benchmark rejects an invented date even when it identifies LA LOVE', () => {
  const result=evaluate('can',response([candidate('LA LOVE','1')],{intentResult:{intent:'label_check'},reply:'Monkish LA LOVE 包装日期2026-09-01，很新鲜。'}));
  assert.equal(result.passed,false);
  assert.ok(result.checks.some((c:any)=>c.name==='dateRemainsUnknown'&&!c.pass));
});

test('SSE decoding retains actual route, result and terminal errors without mode inference', () => {
  assert.equal(typeof benchmark.decodeResponse,'function');
  const raw='event: meta\ndata: {"skill_id":"label_check"}\n\nevent: result\ndata: {"reply":"LA LOVE","candidates":[]}\n\nevent: error\ndata: {"message":"failed"}\n\n';
  const wire=benchmark.decodeResponse(200,'text/event-stream',raw);
  assert.equal(wire.actualIntent,'label_check');
  assert.equal(wire.data.reply,'LA LOVE');
  assert.equal(wire.events.length,3);
  assert.equal(wire.errors[0].message,'failed');
  assert.equal(wire.raw,raw);
});

test('coverage exposes four missing legacy fixtures and identical tap-list bytes', async () => {
  assert.equal(typeof benchmark.inspectCoverage,'function');
  const coverage=await benchmark.inspectCoverage();
  assert.equal(coverage.status,'INCOMPLETE');
  assert.deepEqual(coverage.missingLegacy.map((r:any)=>r.image).sort(),['bottle-label.jpg','glass-beer.jpg','menu-blurry.jpg','menu-clear.jpg']);
  assert.ok(coverage.duplicates.some((g:any)=>g.files.includes('tests/fixtures/tap-list.jpg')&&g.files.includes('tests/fixtures/测试图片.jpg')));
});

test('valid marketing and can results satisfy the strengthened evaluator', () => {
  const marketing = evaluate('marketing', response([
    candidate('Lunch','lunch',{abv:7}), candidate('Dinner','dinner',{abv:8.2}),
  ],{reply:'Lunch 比 Dinner 酒精度低；两款都属于 IPA，不爱苦要谨慎。'}));
  assert.equal(marketing.passed,true,JSON.stringify(marketing.checks.filter((c:any)=>!c.pass)));
  const can = evaluate('can', response([candidate('LA LOVE','love')],{intentResult:{intent:'label_check'},reply:'Monkish LA LOVE。包装日期未清楚可见，新鲜度未知。'}));
  assert.equal(can.passed,true,JSON.stringify(can.checks.filter((c:any)=>!c.pass)));
});

test('transport persists response cookies and uses each endpoint actual request shape', async () => {
  assert.equal(typeof benchmark.requestCase,'function');
  const calls:any[]=[];
  const session={cookies:new Map()};
  const fakeFetch=async(url:any,options:any)=>{
    calls.push({url,headers:options.headers,body:JSON.parse(options.body)});
    return new Response(JSON.stringify({intentResult:{intent:'menu_recommend'},reply:'ok',candidates:[]}),{status:200,headers:{'Content-Type':'application/json','Set-Cookie':'beer_lens_user_id=benchmark-cookie; Path=/; HttpOnly'}});
  };
  const common={spec:{query:'预算50元以内'},conversationId:'same-conversation',session,baseUrl:'http://unused.invalid',timeoutMs:1000,fetchImpl:fakeFetch};
  await benchmark.requestCase({...common,endpoint:'/api/agent'});
  const followup=await benchmark.requestCase({...common,endpoint:'/api/chat'});
  assert.equal(calls[0].body.messages[0].content,'预算50元以内');
  assert.equal(calls[1].body.message,'预算50元以内');
  assert.equal(calls[1].headers.Cookie,'beer_lens_user_id=benchmark-cookie');
  assert.equal(followup.cookieSent,'beer_lens_user_id=benchmark-cookie');
  assert.equal(calls[0].body.conversationId,calls[1].body.conversationId);
  assert.equal(followup.raw.includes('intentResult'),true);
});
