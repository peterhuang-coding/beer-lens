import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openrouterFetch, OpenRouterError } from '../lib/beer-agent/openrouter-client.ts';

// The real production boundary is exercised with fetch replaced only at the
// transport edge. These tests never contact a model or use configured secrets.
const envKeys = ['OPENROUTER_API_KEY', 'OPENROUTER_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const previous = new Map(envKeys.map(key => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.OPENROUTER_API_KEY = 'offline-test-key';
after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const body = { model: 'unchanged-model', messages: [{ role: 'user', content: 'test' }] };
const success = () => Response.json({ choices: [{ message: { content: 'done' } }] });

for (const status of [429, 502, 503, 504]) {
  test(`transient HTTP ${status} retries the same production request and then returns content`, async t => {
    const requests: RequestInit[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
      requests.push(request);
      return requests.length === 1 ? new Response('temporarily unavailable', { status, headers: { 'retry-after': '0' } }) : success();
    });
    assert.equal(await openrouterFetch(body, { timeoutMs: 5000 }), 'done');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].signal, requests[1].signal);
    assert.deepEqual(JSON.parse(String(requests[1].body)), body);
  });
}

for (const content of ['', '   ']) {
  test(`empty content ${JSON.stringify(content)} is retried instead of returned`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? Response.json({ choices: [{ message: { content } }] }) : success());
    assert.equal(await openrouterFetch(body, { timeoutMs: 5000 }), 'done');
    assert.equal(calls, 2);
  });
}

test('authentication errors are not retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unauthorized', { status: 401 }); });
  await assert.rejects(openrouterFetch(body), (error: unknown) => error instanceof OpenRouterError && error.errorCode === '401');
  assert.equal(calls, 1);
});

test('persistent transient errors stop after three total attempts', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unavailable', { status: 503 }); });
  await assert.rejects(openrouterFetch(body, { timeoutMs: 5000 }), (error: unknown) => error instanceof OpenRouterError && error.errorCode === '503');
  assert.equal(calls, 3);
});

test('the total timeout also bounds retry backoff when a caller signal is supplied', async t => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('limited', { status: 429, headers: { 'retry-after': '60' } }); });
  await assert.rejects(openrouterFetch(body, { timeoutMs: 25, signal: controller.signal }), (error: unknown) => error instanceof OpenRouterError && error.errorCode === 'TIMEOUT');
  assert.equal(calls, 1);
  assert.equal(controller.signal.aborted, false);
});

test('an already aborted caller signal makes no transport attempt', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return success(); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(openrouterFetch(body, { signal: controller.signal }), (error: unknown) => error instanceof OpenRouterError && error.errorCode === 'ABORTED');
  assert.equal(calls, 0);
});

test('caller cancellation interrupts retry backoff without another attempt', async t => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return new Response('limited', { status: 429, headers: { 'retry-after': '60' } });
  });
  await assert.rejects(openrouterFetch(body, { timeoutMs: 5000, signal: controller.signal }), (error: unknown) => error instanceof OpenRouterError && error.errorCode === 'ABORTED');
  assert.equal(calls, 1);
});

test('Retry-After is honored until the existing total deadline expires', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('limited', { status: 429, headers: { 'retry-after': '60' } }); });
  await assert.rejects(openrouterFetch(body, { timeoutMs: 400 }), (error: unknown) => error instanceof OpenRouterError && error.errorCode === 'TIMEOUT');
  assert.equal(calls, 1);
});

test('a final connection failure cannot add a fourth attempt through the legacy proxy branch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls < 3) return new Response('unavailable', { status: 503 });
    if (calls === 3) throw new Error('fetch failed');
    return success();
  });
  await assert.rejects(openrouterFetch(body, { timeoutMs: 5000 }), /fetch failed/);
  assert.equal(calls, 3);
});

test('caller cancellation interrupts an active fetch without a retry', async t => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    calls++;
    const signal = options.signal!;
    setTimeout(() => controller.abort(), 10);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(openrouterFetch(body, { signal: controller.signal }), (error: unknown) => error instanceof OpenRouterError && error.errorCode === 'ABORTED');
  assert.equal(calls, 1);
});

// Separate process gives each test a fresh module/proxy lifecycle without
// exposing reset hooks in production or changing this test runner's dispatcher.
function proxyScenario(mode: string) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { getGlobalDispatcher, ProxyAgent } from 'undici';
    const original = getGlobalDispatcher();
    const { openrouterFetch } = await import('./lib/beer-agent/openrouter-client.ts');
    const controller = new AbortController();
    const mode = ${JSON.stringify(mode)};
    let calls = 0, firstUsedProxy = false, restored = false;
    globalThis.fetch = async (_url, options) => {
      calls++;
      if (calls === 1) {
        firstUsedProxy = getGlobalDispatcher() instanceof ProxyAgent;
        throw new Error('fetch failed');
      }
      restored = getGlobalDispatcher() === original;
      if (mode === 'transient' && calls === 2) return new Response('unavailable', { status: 503 });
      if (mode === 'timeout' || mode === 'cancel') {
        if (mode === 'cancel') setTimeout(() => controller.abort(), 10);
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      return Response.json({ choices: [{ message: { content: 'done' } }] });
    };
    let result, code;
    try { result = await openrouterFetch({ model: 'unchanged-model' }, { timeoutMs: mode === 'timeout' ? 25 : 3000, signal: controller.signal }); }
    catch (error) { code = error.errorCode ?? error.name; }
    console.log(JSON.stringify({ calls, firstUsedProxy, restored, result, code }));
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, env: { ...process.env, OPENROUTER_API_KEY: 'offline-test-key', OPENROUTER_PROXY: 'http://127.0.0.1:9' } });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
}

test('proxy connection failure restores the dispatcher captured before proxy setup', () => {
  const outcome = proxyScenario('success');
  assert.equal(outcome.firstUsedProxy, true);
  assert.equal(outcome.restored, true);
  assert.equal(outcome.calls, 2);
  assert.equal(outcome.result, 'done');
});

test('a transient HTTP error after proxy fallback can use the remaining bounded retry', () => {
  const outcome = proxyScenario('transient');
  assert.equal(outcome.calls, 3);
  assert.equal(outcome.result, 'done');
  assert.equal(outcome.restored, true);
});

for (const [mode, expected] of [['timeout', 'TIMEOUT'], ['cancel', 'ABORTED']]) {
  test(`${mode} during proxy fallback is normalized to ${expected}`, () => {
    const outcome = proxyScenario(mode);
    assert.equal(outcome.calls, 2);
    assert.equal(outcome.code, expected);
    assert.equal(outcome.restored, true);
  });
}
