import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
test('Python lookup loads and returns JSON without a preinstalled database',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'beer-python-'));
 try{
 copyFileSync('.beer-data/lookup.py',path.join(dir,'lookup.py'));
 const result=spawnSync('python3',[path.join(dir,'lookup.py'),'--stats'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(typeof JSON.parse(result.stdout),'object');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
