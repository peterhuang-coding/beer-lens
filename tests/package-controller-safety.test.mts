import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runPackageControllerReplay, installFetchDenyGuard} from '../scripts/qa/package-controller.mts';

const SECRET='SYNTHETIC_HOLDOUT_SECRET_NOT_REAL';
const B64=Buffer.from('SYNTHETIC_PRIVATE_IMAGE_BYTES').toString('base64');
async function fixture() {
  const dir=await mkdtemp(path.join(tmpdir(),'beer-root-holdout-'));
  const runDir=path.join(dir,'run'); await mkdir(runDir);
  const imagePath=path.join(dir,'image.png'); await writeFile(imagePath,Buffer.from(B64,'base64'));
  return {dir,options:{imagePath,mime:'image/png' as const,questions:['帮我推荐一杯'],runDir,apiKey:SECRET}};
}

test('root: every existing unusable receipt blocks without submission or overwrite',async()=>{
  for(const contents of ['{"status":"submitting"','null','[]','{}','{"status":"unrecognized"}','{"status":"failed"}']) {
    const {dir,options}=await fixture(); let calls=0;
    try {
      const p=path.join(options.runDir,'receipt.json'); await writeFile(p,contents);
      await assert.rejects(runPackageControllerReplay({...options,fetchImpl:async()=>{calls++;throw new Error('synthetic transport failure');}}));
      assert.equal(calls,0,'existing unusable receipt must never cause resubmission');
      assert.equal(await readFile(p,'utf8'),contents,'receipt evidence must stay unchanged');
    } finally {await rm(dir,{recursive:true,force:true});}
  }
});

test('root: transport error details cannot leak key or image through report, receipt or logs',async()=>{
  const {dir,options}=await fixture();let calls=0;const logs:string[]=[];
  const saved={log:console.log,warn:console.warn,error:console.error};
  for(const k of ['log','warn','error'] as const)console[k]=(...args:unknown[])=>{logs.push(args.map(String).join(' '));};
  try {
    const report=await runPackageControllerReplay({...options,fetchImpl:async()=>{calls++;throw new Error(`Bearer ${SECRET} data:image/png;base64,${B64}`);}});
    assert.equal(report.status,'failed');assert.equal(calls,1);
    const serialized=JSON.stringify(report)+(await readFile(path.join(options.runDir,'report.json'),'utf8'))+(await readFile(path.join(options.runDir,'receipt.json'),'utf8'))+logs.join('\n');
    for(const sensitive of [SECRET,B64,'data:image/png;base64,'])assert.ok(!serialized.includes(sensitive),'sensitive transport details leaked');
  } finally {Object.assign(console,saved);await rm(dir,{recursive:true,force:true});}
});

test('root: blocked URL query, userinfo and fragment are not copied into diagnostics',async()=>{
  const guard=installFetchDenyGuard();let message='';
  try {
    try {await globalThis.fetch(`https://user:${SECRET}@openrouter.ai/test?api_key=${SECRET}#${SECRET}`);}catch(e){message=String(e);}
    assert.equal(guard.blocked.length,1);
    assert.ok(!JSON.stringify(guard.blocked).includes(SECRET));assert.ok(!message.includes(SECRET));
  } finally {guard.restore();}
});
