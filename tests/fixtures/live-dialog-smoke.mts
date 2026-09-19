import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const cwd=process.cwd(),dir=await mkdtemp(join(tmpdir(),'beer-live-dialog-'));
try {
 await mkdir(join(dir,'.beer-data'));
 await copyFile(join(cwd,'.beer-data/lookup.py'),join(dir,'.beer-data/lookup.py'));
 execFileSync('python3',['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE beers (id INTEGER PRIMARY KEY,name TEXT,brewery TEXT,style TEXT,abv REAL,rating REAL,ratings_count INTEGER)')
c.execute('CREATE TABLE untappd_cache (id INTEGER PRIMARY KEY,name TEXT,brewery TEXT,style TEXT,abv REAL,rating REAL,ratings_count INTEGER,untappd_url TEXT,country TEXT,label_image TEXT)')
c.execute('CREATE TABLE beer_cache (id INTEGER PRIMARY KEY,name TEXT,brewery TEXT,style TEXT,abv REAL,rating REAL,ratings_count INTEGER,verified INTEGER DEFAULT 0)')
c.executemany('INSERT INTO beers VALUES (?,?,?,?,?,?,?)',[(1,'Beer A','Example','IPA',6,4,900),(2,'Beer B','Example','Lager',4,4,900)])
c.commit()`,join(dir,'.beer-data/beer.db')]);
 process.chdir(dir);
 process.env.OPENROUTER_API_KEY='test-key';
 globalThis.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify({skill:'recommend',params:{},reason:'controlled routing provider'})}}]});
 const {runAgentTurn}=await import('../../lib/agent/controller.ts');
 const {readShortTermMemory}=await import('../../lib/beer-agent/memory/short-term.ts');
 const request=(text:string,conversationId='one')=>({userId:'isolated-user',channel:'web' as const,conversationId,turnId:crypto.randomUUID(),messages:[{role:'user' as const,content:text}]});
 const menu=await runAgentTurn(request('酒单：\nBeer A ¥55 330ml 6%\nBeer B ¥85 330ml 4%'));
 assert.equal(menu.intentResult.intent,'menu_recommend','public API names must not become internal skill IDs');
 assert.equal((await readShortTermMemory('one','isolated-user'))?.lastMenu?.candidates.length,2,'controller must persist its full response');
 const below=await runAgentTurn(request('预算50元以内，只推荐符合预算的；没有就告诉我没有'));
 assert.equal(below.picks.topPick.candidateId,'');assert.match(below.reply,/没有.*符合/);
 const expanded=await runAgentTurn(request('改成90元以内，只要拉格'));
 assert.equal(expanded.candidates.find(c=>c.candidateId===expanded.picks.topPick.candidateId)?.displayName,'Beer B',JSON.stringify(expanded));
 for (const text of ['哪款？','这个','换一款','清爽一点']) {
  const follow=await runAgentTurn(request(text));
  assert.deepEqual(follow.candidates.map(c=>c.displayName),['Beer A','Beer B'],text);
 }
 assert.equal(await readShortTermMemory('two','isolated-user'),null);
 const missing=await runAgentTurn(request('第3个怎么样','three'));
 assert.equal(missing.intentResult.intent,'unclear');assert.equal(missing.candidates.length,0);
 for(const text of ['哪个最受欢迎','哪个酒精度最高','酒精度高不高']) {
  const cold=await runAgentTurn(request(text,'cold-'+text));
  assert.equal(cold.intentResult.intent,'unclear',text);assert.equal(cold.candidates.length,0,text);
 }
 const fromHistory=await runAgentTurn({...request('这里面哪款苦味最轻？','four'),messages:[{role:'assistant' as const,content:'推荐A和B'},{role:'user' as const,content:'这里面哪款苦味最轻？'}]});
 assert.equal(fromHistory.intentResult.intent,'follow_up_filter');assert.equal(fromHistory.candidates.length,0);
 const fresh=await runAgentTurn(request('酒单：\nBeer B ¥85 330ml 4%','two'));
 assert.equal(fresh.candidates.length,1);assert.equal(fresh.candidates[0].displayName,'Beer B');

 await runAgentTurn(request('预算50元以内'));
 const named=await runAgentTurn(request('Beer A'));
 assert.equal(named.intentResult.intent,'menu_recommend');
 assert.equal(named.candidates[0].abv,6);
 assert.ok(!(await readShortTermMemory('one','isolated-user'))?.currentConstraints?.includes('maxPrice:50'));
 const namedFollow=await runAgentTurn(request('哪款？'));
 assert.equal(namedFollow.picks.topPick.candidateId,named.candidates[0].candidateId);
 const empty=await runAgentTurn(request('酒单：'));
 assert.equal(empty.candidates.length,0);
 assert.equal((await readShortTermMemory('one','isolated-user'))?.lastMenu?.candidates[0].displayName,'Beer A');
 assert.equal((await readShortTermMemory('one','isolated-user'))?.activeBeer?.displayName,'Beer A');

 // Exercise real SSE route, only substituting the external visual executor boundary.
 const {POST}=await import('../../app/api/chat/route.ts');
 const {getSkill,registerSkill}=await import('../../lib/harness/skill-registry.ts');
 const original=getSkill('menu_recommend')!;
 registerSkill({...original,invoke:async(ctx)=>ctx.request.image?{skillId:'recommend',reply:menu.reply,candidates:menu.candidates,picks:menu.picks,profileSummary:'',errors:[]}:original.invoke(ctx)});
 async function chat(message:string,conversationId:string,cookie='',image=false){
  const response=await POST(new Request('http://localhost/api/chat',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({message,conversationId,...(image?{imageDataUrl:'data:image/png;base64,dGVzdA=='}:{})})}));
  const body=await response.text();const result=body.match(/event: result\ndata: (.*)/)?.[1];
  assert.ok(result,body);return {result:JSON.parse(result),cookie:response.headers.get('set-cookie')?.split(';')[0]??cookie};
 }
 const initial=await chat('帮我看这张酒单','browser-one','',true);
 assert.ok(initial.cookie.includes('beer_lens_user='));
 const follow=await chat('预算50元以内，只推荐符合预算的；没有就告诉我没有','browser-one',initial.cookie);
 assert.equal(follow.result.picks.topPick.candidateId,'');assert.equal(follow.result.candidates[0].price,55);
 assert.equal(follow.result.candidates[0].volumeMl,330);
 registerSkill({...original,invoke:async()=>({skillId:'recommend',reply:'识别失败',candidates:[],picks:menu.picks,profileSummary:'',errors:['controlled vision failure']})});
 const failed=await POST(new Request('http://localhost/api/chat',{method:'POST',headers:{'content-type':'application/json',cookie:initial.cookie},body:JSON.stringify({message:'新的酒单',conversationId:'browser-one',imageDataUrl:'data:image/png;base64,dGVzdA=='})}));
 assert.match(await failed.text(),/event: error/);
 const browserId='web_'+initial.cookie.split('=')[1];
 assert.equal((await readShortTermMemory('browser-one',browserId))?.lastMenu?.candidates.length,2);
 registerSkill(original);
 const newConversation=await chat('酒单：\nBeer B ¥85 330ml 4%','browser-two',initial.cookie);
 assert.equal(newConversation.result.candidates.length,1);assert.equal(newConversation.result.candidates[0].displayName,'Beer B');
} finally {process.chdir(cwd);await rm(dir,{recursive:true,force:true});}
