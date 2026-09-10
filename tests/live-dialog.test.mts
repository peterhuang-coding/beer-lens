import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('real dialog wiring preserves menu memory, constraints, identities and public intent names',()=>{
 execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/live-dialog-smoke.mts',import.meta.url))],{cwd:fileURLToPath(new URL('..',import.meta.url)),timeout:30000,stdio:'pipe'});
});
