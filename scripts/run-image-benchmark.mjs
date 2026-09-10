#!/usr/bin/env node
/**
 * Real image acceptance checks against BOTH public endpoints.
 * npm run benchmark:images                        # http://127.0.0.1:3000
 * PORT=3001 REPORT_PATH=data/regression-runs/images.json npm run benchmark:images
 * No report is written unless REPORT_PATH is set. Exit: 0 complete pass,
 * 1 behavioral/transport failure, 2 available cases pass but coverage incomplete.
 * Importing this module never makes network requests.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const ENDPOINTS = ['/api/chat', '/api/agent'];
// Names, counts and prices were checked against these original images and
// docs/test-report-2026-09-11.md. Advertising scores are not reference ratings.
export const IMAGE_CASES = [
  { id: 'tap-menu', image: 'tests/fixtures/tap-list.jpg', query: '帮我看这个酒单', min: 15, max: 20, intent: 'menu_recommend' },
  { id: 'tap-generic', image: 'tests/fixtures/测试图片.jpg', query: '帮我看这张图', min: 15, max: 20, intent: 'menu_recommend' },
  { id: 'el-nido', image: 'public/test-assets/menu-el-nido.png', query: '这酒单帮我挑一杯 IPA,不要太苦', min: 15, max: 20, intent: 'menu_recommend' },
  { id: 'can', image: 'public/test-assets/can-monkish-la-love.png', query: '这瓶是什么酒?', min: 1, max: 1, intent: 'label_check' },
  { id: 'marketing', image: 'public/test-assets/marketing-lunch-dinner.png', query: 'Lunch 和 Dinner 哪个适合我?我不爱苦', min: 2, max: 2, intent: 'menu_recommend' },
];
const FOLLOWUP = { id: 'budget-followup', query: '预算50元以内，只推荐符合预算的；没有就告诉我没有', min: 15, max: 20 };
const ISOLATION = { id: 'conversation-isolation', query: '新酒单：\n1. QA Isolation Amber | QA Brewery | 30元/330ml\n2. QA Isolation Wheat | QA Brewery | 35元/330ml\n推荐这张新酒单中的一款。', min: 2, max: 2, intent: 'menu_recommend' };
const ALL_CASES = [...IMAGE_CASES, FOLLOWUP, ISOLATION];
const names = { 'LA LOVE': /\bla\s+love\b/i, Lunch: /\blunch\b|午餐/i, Dinner: /\bdinner\b|晚餐/i, 'Cyber Sue': /\bcyber\s+sue\b|赛博暴龙|賽博暴龍/i };
const norm = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const candidateName = candidate => candidate.displayName ?? candidate.beerName ?? '';
const candidateKey = candidate => JSON.stringify([norm(candidateName(candidate)), norm(candidate.brewery), candidate.volumeMl ?? null, candidate.price ?? null]);
const hardPickIds = data => ['topPick', 'safePick', 'explorePick'].map(role => data.picks?.[role]?.candidateId).filter(Boolean);
const hasErrorPhrase = text => /出错|发生错误|请重试|再试一次/.test(text);

/** Preserve the complete wire response as well as its public JSON/SSE result. */
export function decodeResponse(status, contentType, raw) {
  const wire = { status, contentType, raw, data: {}, events: [], errors: [], parseError: null, actualIntent: null };
  try {
    if (contentType.includes('text/event-stream')) {
      for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
        const lines = block.split('\n');
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload || payload === '[DONE]') continue;
        wire.events.push({ event, data: JSON.parse(payload) });
      }
      wire.data = wire.events.findLast(entry => entry.event === 'result')?.data ?? {};
      wire.actualIntent = wire.events.find(entry => entry.event === 'meta' && entry.data.skill_id)?.data.skill_id
        ?? wire.events.find(entry => entry.data.skill_id)?.data.skill_id ?? null;
      wire.errors = wire.events.filter(entry => entry.event === 'error').map(entry => entry.data);
      if (!wire.data.reply) wire.data.reply = wire.events.filter(entry => entry.event === 'delta').map(entry => entry.data.text ?? '').join('');
    } else {
      wire.data = JSON.parse(raw);
      wire.actualIntent = wire.data?.intentResult?.intent ?? null;
      wire.errors = wire.data?.errors ?? (wire.data?.error ? [wire.data.error] : []);
    }
  } catch (error) { wire.parseError = error.message; }
  return wire;
}

/** Pure acceptance evaluator, also used by the offline regression tests. */
export function evaluateResponse(id, endpoint, wire, context = {}) {
  const spec = ALL_CASES.find(entry => entry.id === id);
  if (!spec) throw new Error(`Unknown benchmark case: ${id}`);
  const data = wire.data ?? {};
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const reply = typeof data.reply === 'string' ? data.reply : '';
  const intent = wire.actualIntent ?? data.intentResult?.intent ?? null;
  const expectedIntent = id === 'budget-followup' ? (endpoint === '/api/chat' ? 'menu_recommend' : 'follow_up_filter') : spec.intent;
  const checks = [];
  const check = (name, pass, expected, actual) => checks.push({ name, pass: Boolean(pass), expected, actual });
  check('http', wire.status === 200, 200, wire.status);
  check('parse', !wire.parseError, 'valid JSON or SSE', wire.parseError);
  check('actualIntent', intent === expectedIntent, expectedIntent, intent);
  check('noErrors', !(wire.errors?.length || data.errors?.length || data.error), 'no structured errors', wire.errors ?? data.errors ?? data.error ?? []);
  check('reply', reply.trim().length > 0 && !hasErrorPhrase(reply), 'nonempty reply without error phrases', reply);
  if (endpoint === '/api/chat') {
    check('sseComplete', wire.events?.some(entry => entry.event === 'done'), 'terminal done event', wire.events?.map(entry => entry.event));
    const routes = wire.events?.map(entry => entry.data?.skill_id).filter(Boolean) ?? [];
    check('consistentRoute', new Set(routes).size <= 1, 'one actual SSE route', routes);
  }
  check('candidateCount', candidates.length >= spec.min && candidates.length <= spec.max, `${spec.min}..${spec.max}`, candidates.length);
  const ids = candidates.map(candidate => candidate.candidateId);
  check('uniqueIds', ids.every(Boolean) && new Set(ids).size === ids.length, 'all candidate IDs present and unique', ids);
  check('uniqueIdentities', new Set(candidates.map(candidateKey)).size === candidates.length, 'no repeated beer/brewery/serving offer', candidates.map(candidateKey));
  const picks = hardPickIds(data);
  check('validPickIds', picks.every(pick => ids.includes(pick)), 'hard picks reference actual candidates', picks);
  if (id !== 'can' && id !== 'budget-followup') check('topPick', Boolean(data.picks?.topPick?.candidateId), 'nonempty top pick', data.picks?.topPick?.candidateId);
  const entity = name => {
    const matches = candidates.filter(candidate => names[name].test(candidateName(candidate)));
    check(`entity:${name}`, matches.length === 1, 'exactly one named candidate', matches.map(candidateName));
    return matches[0];
  };
  if (id.startsWith('tap-') || id === 'budget-followup') {
    const cyber = entity('Cyber Sue');
    check('cyberPriceVolume', cyber?.price === 85 && cyber?.volumeMl === 425, { price: 85, volumeMl: 425 }, { price: cyber?.price, volumeMl: cyber?.volumeMl });
    check('cyberABV', Math.abs((cyber?.abv ?? 0) - 7.2) < 0.05, 7.2, cyber?.abv);
    check('ocrEvidence', candidates.filter(c => c.evidence?.some(e => e.source === 'ocr' && e.summary?.trim())).length >= 15, 'at least 15 rows retain OCR evidence', candidates.filter(c => c.evidence?.some(e => e.source === 'ocr' && e.summary?.trim())).length);
  }
  if (id === 'el-nido') {
    const love = entity('LA LOVE');
    const lunch = entity('Lunch');
    check('elNidoBreweries', /monkish/i.test(love?.brewery ?? '') && /maine/i.test(lunch?.brewery ?? ''), 'LA LOVE=Monkish, Lunch=Maine', [love?.brewery, lunch?.brewery]);
    check('ipaHardPicks', picks.length > 0 && picks.every(pick => /ipa|india pale ale/i.test(candidates.find(c => c.candidateId === pick)?.style ?? '')), 'all top/safe/explore choices are IPA', picks.map(pick => candidates.find(c => c.candidateId === pick)?.style));
  }
  if (id === 'marketing') {
    const lunch = entity('Lunch');
    const dinner = entity('Dinner');
    check('distinctComparison', lunch && dinner && lunch.candidateId !== dinner.candidateId, 'Lunch and Dinner remain distinct', [lunch?.candidateId, dinner?.candidateId]);
    check('comparisonReply', names.Lunch.test(reply) && names.Dinner.test(reply), 'reply addresses Lunch and Dinner', reply);
    check('marketingABV', lunch?.abv === 7 && dinner?.abv === 8.2, [7, 8.2], [lunch?.abv, dinner?.abv]);
    check('verifiedRatingsOnly', candidates.every(c => c.untappdScore == null || c.evidence?.some(e => /已核验|本地 (?:untappd|beer_cache|ratebeer)/.test(e.summary ?? '') && e.source !== 'ocr')), 'ratings require independently matched/verified beer evidence, not advertising text', candidates.map(c => ({ name: candidateName(c), rating: c.untappdScore, evidence: c.evidence })));
  }
  if (id === 'can') {
    const love = entity('LA LOVE');
    check('canBrewery', /monkish/i.test(love?.brewery ?? '') && /monkish/i.test(reply), 'Monkish in candidate and reply', { brewery: love?.brewery, reply });
    check('dateRemainsUnknown', /日期[^。\n]*(?:未|不|未知)|(?:未|不)[^。\n]*日期/.test(reply) && /新鲜度[^。\n]*(?:未知|无法|不能)/.test(reply) && !/20\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(reply), 'no visible packaging date; freshness unknown', reply);
  }
  if (id === 'budget-followup') {
    const baselineCandidates = context.baseline?.data?.candidates ?? [];
    check('sameMenu', baselineCandidates.length >= 15 && JSON.stringify([...ids].sort()) === JSON.stringify(baselineCandidates.map(c => c.candidateId).sort()), 'same complete menu IDs as the previous image turn', { previous: baselineCandidates.map(c => c.candidateId), current: ids });
    check('noBudgetPicks', picks.length === 0, 'no hard picks: complete fixture minimum price is ¥55', picks);
    check('budgetExplanation', /没有|暂无|无符合/.test(reply) && /预算|50|五十/.test(reply), 'explicitly says nothing meets ¥50 budget', reply);
    check('cookiePreserved', Boolean(context.cookieSent), 'same browser cookie sent on follow-up', Boolean(context.cookieSent));
  }
  if (id === 'conversation-isolation') {
    const expected = ['qa isolation amber', 'qa isolation wheat'];
    check('newMenuOnly', JSON.stringify(candidates.map(c => norm(candidateName(c))).sort()) === JSON.stringify(expected), 'only the two newly supplied QA menu entries', candidates.map(candidateName));
    check('newConversation', Boolean(context.previousConversationId) && context.conversationId !== context.previousConversationId, 'different conversation ID within same browser', [context.previousConversationId, context.conversationId]);
    check('cookiePreserved', Boolean(context.cookieSent), 'same browser cookie across conversations', Boolean(context.cookieSent));
  }
  return { passed: checks.every(entry => entry.pass), actualIntent: intent, candidateCount: candidates.length, checks };
}

export async function inspectCoverage(root = ROOT) {
  const legacy = JSON.parse(await readFile(path.join(root, 'tests/e2e/image-qa.json'), 'utf8')).filter(entry => entry.enabled);
  const missingLegacy = legacy.filter(entry => !existsSync(path.join(root, 'tests/fixtures', entry.image)));
  const unexecutedLegacy = legacy.filter(entry => entry.image !== 'tap-list.jpg' && !missingLegacy.includes(entry));
  const files = [...new Set(IMAGE_CASES.map(entry => entry.image))];
  const assets = await Promise.all(files.map(async file => existsSync(path.join(root, file))
    ? { file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') }
    : { file, missing: true }));
  const groups = new Map();
  for (const asset of assets) if (asset.sha256) groups.set(asset.sha256, [...(groups.get(asset.sha256) ?? []), asset.file]);
  return { status: missingLegacy.length || unexecutedLegacy.length || assets.some(asset => asset.missing) ? 'INCOMPLETE' : 'COMPLETE', missingLegacy, unexecutedLegacy, assets, uniqueImageCount: groups.size, duplicates: [...groups].filter(([, group]) => group.length > 1).map(([sha256, files]) => ({ sha256, files, note: 'same bytes; prompts test different behavior, not independent visual coverage' })) };
}

/** One browser session per endpoint. Cookies are sent on every subsequent turn. */
export async function requestCase({ endpoint, spec, conversationId, session, baseUrl, timeoutMs, fetchImpl = fetch }) {
  const cookieSent = [...session.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const request = { conversationId, query: spec.query, image: spec.image ?? null };
  try {
    const imageBytes = spec.image ? await readFile(path.join(ROOT, spec.image)) : null;
    const imageType = spec.image ? MIME[path.extname(spec.image)] ?? 'image/jpeg' : undefined;
    const dataUrl = imageBytes ? `data:${imageType};base64,${imageBytes.toString('base64')}` : undefined;
    const body = endpoint === '/api/chat'
      ? { message: spec.query, conversationId, imageDataUrl: dataUrl, imageName: spec.image, imageType }
      : { messages: [{ role: 'user', content: spec.query }], conversationId, metadata: { benchmark: true, writeBadcases: false }, ...(dataUrl ? { image: { dataUrl, name: spec.image, type: imageType } } : {}) };
    const response = await fetchImpl(`${baseUrl}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookieSent ? { Cookie: cookieSent } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const value of setCookies) {
      const pair = value.split(';', 1)[0]; const equals = pair.indexOf('=');
      if (equals > 0) session.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    const wire = decodeResponse(response.status, response.headers.get('content-type') ?? '', await response.text());
    return { request, cookieSent, setCookies, responseHeaders: Object.fromEntries(response.headers), ...wire };
  } catch (error) { return { request, cookieSent, status: 0, data: {}, events: [], raw: '', errors: [error.message], parseError: error.message }; }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('PORT=3000 REPORT_PATH=data/regression-runs/images.json npm run benchmark:images\nRuns /api/chat and /api/agent. REPORT_PATH optional; must be gitignored or outside the repository. TIMEOUT_MS defaults to 240000. Exit 1=failed, 2=missing coverage.');
    return;
  }
  const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${Number(process.env.PORT ?? 3000)}`;
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 240000);
  const reportPath = process.env.REPORT_PATH ? path.resolve(ROOT, process.env.REPORT_PATH) : null;
  if (reportPath && !path.relative(ROOT, reportPath).startsWith('..')) {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', reportPath], { cwd: ROOT }); }
    catch { throw new Error('REPORT_PATH must be gitignored (for example data/regression-runs/images.json) or outside the repository.'); }
  }
  const coverage = await inspectCoverage();
  const runId = `images-${randomUUID()}`;
  const report = { runId, startedAt: new Date().toISOString(), baseUrl, timeoutMs, endpoints: ENDPOINTS, reference: 'docs/test-report-2026-09-11.md and original image pixels', coverage, results: [] };
  const save = async () => { if (reportPath) { await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); } };
  console.log(`Image acceptance: ${baseUrl}, both endpoints; ${coverage.uniqueImageCount} distinct images.`);
  for (const entry of coverage.missingLegacy) console.log(`MISSING COVERAGE: ${entry.id} (${entry.image})`);
  for (const entry of coverage.duplicates) console.log(`DUPLICATE IMAGE: ${entry.files.join(' = ')} SHA256=${entry.sha256}`);
  for (const endpoint of ENDPOINTS) {
    const session = { cookies: new Map() };
    let baseline; let previousConversationId;
    const sequence = [IMAGE_CASES[0], FOLLOWUP, ISOLATION, ...IMAGE_CASES.slice(1)];
    for (const spec of sequence) {
      const conversationId = spec.id === 'budget-followup' ? previousConversationId : `${runId}-${endpoint.slice(5)}-${spec.id}`;
      const started = Date.now();
      const wire = spec.image && !existsSync(path.join(ROOT, spec.image)) ? null : await requestCase({ endpoint, spec, conversationId, session, baseUrl, timeoutMs });
      const evaluation = wire ? evaluateResponse(spec.id, endpoint, wire, { baseline, previousConversationId, conversationId, cookieSent: wire.cookieSent }) : null;
      const result = { endpoint, caseId: spec.id, conversationId, status: wire ? (evaluation.passed ? 'PASS' : 'FAIL') : 'MISSING_COVERAGE', durationMs: Date.now() - started, evaluation, response: wire };
      report.results.push(result);
      console.log(`${endpoint} ${spec.id}: ${result.status}${evaluation ? ` (${evaluation.candidateCount} candidates; actual route=${evaluation.actualIntent})` : ''}`);
      for (const check of evaluation?.checks ?? []) if (!check.pass) console.log(`  ${check.name}: expected ${JSON.stringify(check.expected)}, actual ${JSON.stringify(check.actual)}`);
      if (spec.id === 'tap-menu') { baseline = wire; previousConversationId = conversationId; }
      await save();
    }
  }
  const failed = report.results.filter(result => result.status === 'FAIL').length;
  const missing = report.results.filter(result => result.status === 'MISSING_COVERAGE').length;
  const incomplete = coverage.status === 'INCOMPLETE' || missing > 0;
  report.summary = { status: failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS', passed: report.results.filter(result => result.status === 'PASS').length, failed, missing, total: report.results.length, coverageStatus: coverage.status };
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report.summary));
  if (reportPath) console.log(`Full responses: ${reportPath}`);
  process.exitCode = failed ? 1 : incomplete ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
