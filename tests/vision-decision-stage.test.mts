import test from 'node:test';
import assert from 'node:assert/strict';
import { vision } from '../lib/multimodal/index.ts';
import { runMultiStagePipeline } from '../lib/beer-agent/multi-stage-pipeline.ts';

test('image decision path stops after extraction when recommendation is supplied by the skill',async()=>{
 const original=vision.call;
 const events:any[]=[];
 vision.call=(async()=>({parsed:{imageContext:{imageType:'menu'},extracted:{items:[{beerName:'Example IPA'}]},visualQuality:{canAssess:false}}})) as typeof vision.call;
 try {
  const result=await runMultiStagePipeline({apiKey:'test',imageDataUrl:'data:image/png;base64,eA==',userText:'推荐',profile:'',skipRecommendation:true,onProgress:event=>events.push(event)});
  assert.equal(result.extracted.items[0].beerName,'Example IPA');
  assert.equal(result.recommendation.reply,'');
  assert.ok(!events.some(e=>e.stage==='recommendation'));
 } finally {vision.call=original;}
});
