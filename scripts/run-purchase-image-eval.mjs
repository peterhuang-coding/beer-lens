import {requestCase} from './run-image-benchmark.mjs';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
const out=path.resolve(process.env.REPORT_DIR??'docs/test-results/2026-09-18-purchase');
const tap='tests/fixtures/tap-list.jpg', ad='public/test-assets/marketing-lunch-dinner.png';
const cases=[
{id:'budget70',image:tap,query:'预算70元，第一杯想清爽一点、不太苦。请从这张酒单选一杯，并给一个备选，写出两者价格、容量和差价。',expected:'候选必须在70元内；#7科隆55/425ml与#1年轻领主60/425ml是合理首选/备选，差5元；不凭风格断言实际苦度。'},
{id:'budget50',image:tap,follow:true,query:'预算改为50元以内，只推荐符合预算的；没有就告诉我没有。',expected:'沿用上一轮图片；可读完整菜单最低55元，无符合者，不推荐超预算或未知价格酒款。'},
{id:'same-volume',image:tap,query:'只比较第1号年轻领主和第7号科隆，我两种风格都接受。哪款单位价低？请列杯价、容量、每100ml价格和差价，不要拿评分代替性价比。',expected:'年轻领主60元/425ml=14.12元/100ml；科隆55元/425ml=12.94元/100ml；科隆便宜5元。价格结论不等于品质结论。'},
{id:'volume-choice',image:tap,query:'只比较第3号赛博暴龙和第18号甜甜圈波士顿奶油，两款都是85元。我这次只想喝300ml左右，也接受这两种风格。请算每100ml价格，并解释该选哪杯；不要只因为容量大就推荐。',expected:'赛博暴龙85/425=20元/100ml；#18为85/300=28.33元/100ml。前者单位价低，后者容量更合本次需求；应说明后者11.5%与前者7.2%的酒精度差异，允许有理由的澄清而非唯一硬标签。'},
{id:'missing-price',image:ad,query:'Lunch和Dinner哪款性价比更高、值得买？请比较实际价格和每100ml价格；图片没有的不要猜。',expected:'广告没有价格或容量，不能计算单位价、价差或确定性价比赢家；应索取报价/规格。广告评分不能代替价量证据。'}
];
await mkdir(out,{recursive:true});
await mkdir(path.join(out,'images'),{recursive:true});
const assets=[];
for(const src of [tap,ad]){const bytes=await readFile(src);await copyFile(src,path.join(out,'images',path.basename(src)));assets.push({src,sha256:createHash('sha256').update(bytes).digest('hex')});}
const report={startedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:'existing production build; build source commit not attested',scope:'5 scenarios × 2 APIs; 2 unique originals; follow-up reuses prior image and cookie; not a population accuracy estimate',assets,cases,results:[]};
await writeFile(path.join(out,'manifest.json'),JSON.stringify({scope:report.scope,assets,cases},null,2));
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
for(const endpoint of ['/api/chat','/api/agent']){
const session={cookies:new Map()};let prior;
for(const spec of cases){
const conversationId=spec.follow?prior:`purchase-${randomUUID()}`; if(!spec.follow)prior=conversationId;
const started=Date.now();
const wire=await requestCase({endpoint,spec:{...spec,image:spec.follow?undefined:spec.image},conversationId,session,baseUrl:process.env.BASE_URL??'http://127.0.0.1:3000',timeoutMs:180000});
const d=wire.data??{},reply=d.reply??'';
const checks=[{name:'请求与解析成功',pass:wire.status===200&&!wire.parseError&&!wire.errors?.length},{name:'非空回答',pass:!!reply.trim()},{name:'沿用图片会话',pass:!spec.follow||!!wire.cookieSent}];
if(spec.id==='same-volume')checks.push({name:'回答包含两项单位价（自动文本初筛）',pass:/14\.12/.test(reply)&&/12\.94/.test(reply)});
if(spec.id==='volume-choice')checks.push({name:'回答包含两项单位价（自动文本初筛）',pass:/20(?:\.0+)?/.test(reply)&&/28\.33/.test(reply)});
if(spec.id==='budget50')checks.push({name:'结构化结果无硬推荐',pass:!['topPick','safePick','explorePick'].some(k=>d.picks?.[k]?.candidateId)});
report.results.push({id:spec.id,endpoint,query:spec.query,image:'images/'+path.basename(spec.image),expected:spec.expected,durationMs:Date.now()-started,httpStatus:wire.status,checks,review:{status:'PENDING',reason:'待逐条语义审阅；自动文本初筛不等于任务成功'},reply,data:d,raw:wire.raw,errors:wire.errors});
await save(); console.log(endpoint,spec.id,wire.status,Math.round((Date.now()-started)/1000)+'s',checks.filter(c=>!c.pass).map(c=>c.name).join(';'));
}}
report.finishedAt=new Date().toISOString();await save();
