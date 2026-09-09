import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('skill failures reach the router, trace, and SSE without leaking upstream details', () => {
  execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/skill-error-smoke.mts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    timeout: 30000,
    stdio: 'pipe',
  });
});
