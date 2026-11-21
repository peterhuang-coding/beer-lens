import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../',import.meta.url));
test('per-100ml request preserves the full menu and constraints across five controller turns',async()=>{
const directory=await mkdtemp(path.join(tmpdir(),'beer-photo-numeric-acceptance-'));
const url=n=>pathToFileURL(path.join(repo,n)).href;
const facts=JSON.parse(await readFile(new URL('fixtures/el-nido-menu-numbers.json',import.meta.url),'utf8'));
const source=String.raw`
import {writeFile} from 'node:fs/promises';
let attemptedNetwork=0;globalThis.fetch=async()=>{attemptedNetwork++;throw Error('offline acceptance prohibits network');};
const {updateShortTermMemory,readShortTermMemory}=await import(${JSON.stringify(url('lib/beer-agent/memory/short-term.ts'))});
const {runAgentTurn}=await import(${JSON.stringify(url('lib/agent/controller.ts'))});
const facts=${JSON.stringify(facts)};
const rows=facts.rows.map(x=>({...x,candidateId:'photo-slot-'+x.menuIndex,displayName:'图中第'+x.menuIndex+'号',brewery:'',style:'',hops:[],evidence:[],riskFlags:[],worthScore:0,fitScore:0,reason:'',untappdScore:null}));
const id='synthetic-manual-photo-numbers';
const blank={candidateId:'',label:'',reason:'',worthScore:0,fitScore:0};
const base={userId:id,conversationId:id,channel:'feishu'};
await updateShortTermMemory({...base,turnId:'manual-seed',image:{dataUrl:'synthetic-manually-transcribed-not-vqa'},messages:[{role:'user',content:'酒单'}]}, {traceId:'manually-transcribed-numeric-reference',turnId:'manual-seed',reply:'人工转录数字，仅验证下游算法',candidates:rows,picks:{topPick:blank,safePick:blank,explorePick:blank,avoidOrCaution:blank},intentResult:{intent:'menu_recommend'}});
const initialMenuCount=(await readShortTermMemory(id,id)).lastMenu?.candidates.length;
if(initialMenuCount!==17)throw Error('invalid seed');
const cases=[
 {q:'按每100ml价格给我推荐最便宜的',expected:[3,4],constraints:['priceGoal:unit']},
 {q:'预算80元，只想喝300ml左右，按单位价挑',expected:[10],constraints:['maxPrice:80','aroundVolumeMl:300','priceGoal:unit']},
 {q:'酒精度6%以内，其他条件不变',expected:[5,7],constraints:['maxPrice:80','aroundVolumeMl:300','maxAbv:6','priceGoal:unit']},
 {q:'预算改成60元',expected:[],constraints:['maxPrice:60','aroundVolumeMl:300','maxAbv:6','priceGoal:unit']},
 {q:'预算改成100元',expected:[5,7],constraints:['maxPrice:100','aroundVolumeMl:300','maxAbv:6','priceGoal:unit']}
];
const messages=[],results=[];
for(const [i,c] of cases.entries()){
 messages.push({role:'user',content:c.q});
 const result=await runAgentTurn({...base,turnId:'turn-'+i,messages:[...messages]});
 const memory=await readShortTermMemory(id,id);
 const pick=result.picks.topPick.candidateId;
 const number=pick?Number(pick.replace('photo-slot-','')):null;
 const pickPass=c.expected.length?c.expected.includes(number):!pick;
 const constraintsPass=c.constraints.every(x=>memory.currentConstraints?.includes(x));
 const fullMenuRetained=memory.lastMenu?.candidates.length===17;
 results.push({question:c.q,expectedTopMenuIndices:c.expected,actualTopMenuIndex:number,actualPickId:pick,remainingMenuCount:memory.lastMenu?.candidates.length,constraints:memory.currentConstraints,pickPass,constraintsPass,fullMenuRetained,reply:result.reply,intent:result.intentResult.intent,warnings:result.debug?.warnings??[]});
 messages.push({role:'assistant',content:result.reply});
}
await writeFile('result.json',JSON.stringify({source:'manually transcribed photo numeric fields; synthetic names; actual controller',realModel:false,realImageExtraction:false,realFeishuTransport:false,initialMenuCount,attemptedNetwork,total:results.length,passed:results.filter(x=>x.pickPass&&x.constraintsPass&&x.fullMenuRetained).length,results},null,2));
`;
try{
 const child=spawnSync(process.execPath,['--import',path.join(repo,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','--eval',source],{cwd:directory,encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:directory,TSX_TSCONFIG_PATH:path.join(repo,'tsconfig.json'),NODE_OPTIONS:'--max-old-space-size=1024',GOMAXPROCS:'1',UV_THREADPOOL_SIZE:'1'}});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 const result=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));
 assert.equal(result.total,5);
 assert.equal(result.passed,5,JSON.stringify(result));
 assert.equal(result.attemptedNetwork,0,'acceptance must stay offline');
}finally{await rm(directory,{recursive:true,force:true});}

});
