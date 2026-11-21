import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codingPlanProvider as provider} from '../lib/multimodal/providers/coding-plan.ts';
import {VisionNetworkError} from '../lib/multimodal/errors.ts';
const input={image:{base64:'SYNTHETIC_IMAGE',mime:'image/png'},prompt:'SYNTHETIC_PROMPT'};
const opts={model:'doubao-seed-evolving',timeoutMs:15};
const scenarios=[
 ['null-envelope','PARSE',async()=>({ok:true,status:200,json:async()=>null})],
 ['body-timeout','TIMEOUT',async(_u,init)=>({ok:true,status:200,json:async()=>new Promise((_r,reject)=>{init.signal.addEventListener('abort',()=>{const e=new Error('SYNTHETIC_BODY');e.name='AbortError';reject(e)},{once:true})})})],
 ['body-network','NETWORK',async()=>({ok:true,status:200,json:async()=>{throw new TypeError('SYNTHETIC_NETWORK')}})],
 ['typed-transport-redaction','NETWORK',async()=>{throw new VisionNetworkError('SYNTHETIC_KEY_ONLY SYNTHETIC_IMAGE SYNTHETIC_PROMPT','SYNTHETIC_PROVIDER')}],
];
for(const [name,expected,fn] of scenarios)test(String(name),async()=>{const oldFetch=globalThis.fetch;const oldKey=process.env.CODING_PLAN_API_KEY;process.env.CODING_PLAN_API_KEY='SYNTHETIC_KEY_ONLY';let calls=0;
 globalThis.fetch=async(...args)=>{calls++;return fn(...args)};
 try{await assert.rejects(provider.call(input,opts),e=>{assert.equal(e.code,expected);assert.doesNotMatch(e.message+' '+e.stack+' '+JSON.stringify(e),/SYNTHETIC_(KEY|IMAGE|PROMPT|PROVIDER|BODY|NETWORK)/);return true});assert.equal(calls,1)}finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.CODING_PLAN_API_KEY;else process.env.CODING_PLAN_API_KEY=oldKey;}});
