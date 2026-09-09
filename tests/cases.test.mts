import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('case review validates updates, preserves evidence, and supports filtering', async () => {
  const original = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'beer-cases-'));
  process.chdir(dir);
  try {
    await mkdir('data');
    const record = { id: 'case_test', traceId: 'trace_test', createdAt: '2026-09-10', input: { text: 'IPA please', hasImage: false }, intent: { name: 'recommend', confidence: 1 }, replyPreview: 'Try a lager', candidateCount: 1, label: null, status: 'unlabeled', warnings: [] };
    await writeFile('data/cases.json', JSON.stringify([record]));
    const { updateCase, listCases, getCase } = await import('../lib/beer-agent/cases.ts');
    for (const invalid of [{ status: 'broken' }, { label: 'nonsense' }, { note: 42 }, { id: 'overwrite' }, { expected: { reply: 12 } }, null, []]) {
      await assert.rejects(() => updateCase('case_test', invalid as never), /invalid_case_update/);
    }
    assert.deepEqual(JSON.parse(await readFile('data/cases.json', 'utf8')), [record]);
    const updated = await updateCase('case_test', { label: 'recommendation_bad', status: 'reviewed', note: 'Asked for IPA' });
    assert.equal(updated?.note, 'Asked for IPA');
    assert.equal(updated?.traceId, record.traceId);
    assert.equal((await listCases({ status: 'reviewed', label: 'recommendation_bad', search: 'IPA' })).length, 1);
    assert.equal((await listCases({ status: 'fixed' })).length, 0);
    await updateCase('case_test', { label: null });
    assert.equal((await getCase('case_test'))?.status, 'unlabeled');
    assert.equal(await updateCase('missing', { note: 'x' }), null);
  } finally {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
});
