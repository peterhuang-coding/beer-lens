import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = "/Volumes/SanDisk2TB/beer-lens-feishu-harness";
const HUB = "/Volumes/SanDisk2TB/claude-pm-hub/projects/beer-lens/test-runs/2026-10-29-deepseek-diagnostic/live-diagnostic-report.json";
const OUT = process.argv[2];
if (!OUT) throw new Error("output path required");

const report = JSON.parse(await readFile(HUB, "utf8"));
const raw = report.transport.requests.find((r: any) => r.provider === "deepseek")?.modelContent;
if (typeof raw !== "string") throw new Error("captured DeepSeek content missing");
const parsed = JSON.parse(raw);
const items = parsed.extracted?.items;
if (!Array.isArray(items) || items.length !== 17) throw new Error(`expected 17 captured items, got ${items?.length}`);

process.env.BEER_VISION_PROVIDER = "deepseek";
process.env.BEER_TEXT_PROVIDER = "coding-plan";
process.env.CODING_PLAN_API_KEY = "offline-replay-key";
process.env.DEEPSEEK_API_KEY = "offline-replay-key";
process.env.BEER_FIRST_REPLY_BUDGET_MS = "60000";
process.env.BEER_REPLY_RESERVE_MS = "4000";

const stateDir = await mkdtemp(path.join(tmpdir(), "beer-lens-current-replay-"));
const originalCwd = process.cwd();
const record: Record<string, any> = {
  evidenceLayer: "captured real DeepSeek output replay against current production source; zero real model/network requests; isolated state",
  capturedImageSha256: report.image?.sha256 ?? null,
  capturedQuestion: report.question,
  items: items.length,
  initial: null,
  followUps: [] as any[],
  cancel: null,
  textRequests: [] as any[],
  checks: {} as Record<string, boolean>,
};
async function save() {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(record, null, 2) + "\n");
}
async function copyState(relative: string, optional = false) {
  const target = path.join(stateDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  try { await copyFile(path.join(ROOT, relative), target); }
  catch (error) { if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function timed<T>(name: string, fn: () => Promise<T>): Promise<{ value: T; ms: number; wallMs: number }> {
  const wall = Date.now();
  const mono = performance.now();
  return fn().then(value => ({ value, ms: Math.round(performance.now() - mono), wallMs: Date.now() - wall }));
}
function slim(response: any) {
  return {
    reply: response.reply,
    intent: response.intentResult?.intent ?? null,
    route: response.debug?.route ?? null,
    warnings: response.debug?.warnings ?? [],
    candidateCount: response.candidates?.length ?? 0,
    picks: response.picks,
  };
}

try {
  for (const relative of [
    ".beer-data/lookup.py", ".beer-data/beer.db", "data/beer_cache.json",
    "data/events/mbcb-2026-red.json", "data/menus/elnido-2026-10.json",
    "data/menus/elnido-2026-10-additions.json",
  ]) await copyState(relative, relative === "data/beer_cache.json");
  await writeFile(path.join(stateDir, "data", "pipeline-config.json"),
    JSON.stringify({ memoryExperiment: { enabled: false } }, null, 2) + "\n");

  process.chdir(stateDir);
  const importRuntime = (relative: string) => import(pathToFileURL(path.join(ROOT, relative)).href);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    let body: any = {};
    try { body = JSON.parse(String(init.body ?? "{}")); } catch {}
    const system = Array.isArray(body.messages)
      ? body.messages.find((m: any) => m.role === "system")?.content ?? ""
      : "";
    const user = Array.isArray(body.messages)
      ? body.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n")
      : "";
    record.textRequests.push({ url, model: body.model ?? null, system, user });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "（离线桩回复）已按当前菜单上下文回答：款级事实与风格通性分开，具体价格仅做菜单内算术。" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const { container } = await importRuntime("lib/multimodal/container.ts");
  const originalContainerCall = (container as any).call;
  (container as any).call = async () => ({
    raw, parsed, fromCache: true, provider: "replay", model: "captured-deepseek-flash",
    durationMs: 0, attempts: [],
  });
  const memoryModule = await importRuntime("lib/beer-agent/memory/short-term.ts");
  const controller = await importRuntime("lib/agent/controller.ts");

  const imageBytes = await readFile(path.join(ROOT, "tests/fixtures/tap-list.jpg"));
  const userId = "offline-current-user";
  const conversationId = "offline-current-conversation";
  const progress: any[] = [];
  const progressOrigin = performance.now();
  const progressStarts = new Map<string, number>();
  const onProgress = (event: any) => {
    const now = performance.now();
    const stage = event.type.startsWith("enrich_") ? "enrich" : event.stage ?? null;
    const key = String(stage ?? "unknown");
    const entry: any = { type: event.type, stage, monotonicOffsetMs: Math.round(now - progressOrigin),
      ...(event.done !== undefined ? { done: event.done } : {}),
      ...(event.total !== undefined ? { total: event.total } : {}),
      ...(event.count !== undefined ? { count: event.count } : {}) };
    if (event.type.endsWith("_start")) progressStarts.set(key, now);
    if (event.type.endsWith("_done") || event.type.endsWith("_error")) {
      const started = progressStarts.get(key);
      if (started !== undefined) entry.durationMonotonicMs = Math.round(now - started);
    }
    progress.push(entry);
  };

  const initial = await timed("initial", () => controller.runAgentTurn({
    userId, conversationId, turnId: "offline-current-1", channel: "cli",
    deadlineAtMs: Date.now() + 56_000, onProgress,
    messages: [{ role: "user", content: report.question }],
    image: { name: "tap-list.jpg", type: "image/jpeg", dataUrl: `data:image/jpeg;base64,${imageBytes.toString("base64")}` },
  }));
  record.initial = { ...slim(initial.value), monotonicMs: initial.ms, wallMs: initial.wallMs, progress };
  await save();

  const memoryAfterInitial = await memoryModule.readShortTermMemory(conversationId, userId);
  record.checks.stmMenuCount17 = (memoryAfterInitial?.lastMenu?.candidates?.length ?? 0) === 17;
  record.checks.stmAllSeventeenNamed = items.every((item: any) =>
    memoryAfterInitial?.lastMenu?.candidates?.some((c: any) => c.displayName.includes(item.beerName.split("（")[0].slice(0, 12))));
  record.checks.allMenuRowsHavePrice = (memoryAfterInitial?.lastMenu?.candidates ?? []).every((c: any) => c.price != null);
  record.checks.progressVisionDone = progress.some(e => e.type === "stage_done" && e.stage === "vision");
  record.checks.progressEnrichDone = progress.some(e => e.type === "enrich_done");

  const questions = [
    "我预算100元以内，想要清爽不苦，选哪款？",
    "哪款酒花最香？",
    "哪款是经典款？",
    "第7款多少钱？",
    "为什么推荐第一款？",
  ];
  let history: any[] = [{ role: "user", content: report.question }, { role: "assistant", content: initial.value.reply }];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const textStart = record.textRequests.length;
    const turn = await timed(`followUp${i + 1}`, () => controller.runAgentTurn({
      userId, conversationId, turnId: `offline-current-f${i + 1}`, channel: "cli",
      deadlineAtMs: Date.now() + 56_000,
      messages: [...history, { role: "user", content: q }],
    }));
    const entry: any = { question: q, ...slim(turn.value), monotonicMs: turn.ms, wallMs: turn.wallMs };
    entry.textCalls = record.textRequests.slice(textStart).map((last: any) => ({
      systemLength: last.system.length,
      hasRoster: /【全单简明名册】共 17 款/.test(last.system),
      rosterRows: (last.system.match(/^\· #/gm) ?? []).length,
      hasStyleInferenceLabel: /风格通性，非本款事实/.test(last.system),
      hasSourcedUrls: /URL https:\/\//.test(last.system),
    }));
    record.followUps.push(entry);
    history = [...history, { role: "user", content: q }, { role: "assistant", content: turn.value.reply }];
    await save();
  }

  const memoryAfterFollowUps = await memoryModule.readShortTermMemory(conversationId, userId);
  const menuContextModule = await importRuntime("lib/skills/beer-knowledge/menu-context.ts");
  const menuSection = menuContextModule.buildMenuPromptSection(memoryAfterFollowUps, "哪款酒花最香？");
  record.finalMenuSection = {
    hasRoster: /【全单简明名册】共 17 款/.test(menuSection),
    rosterRows: (menuSection.match(/^\· #/gm) ?? []).length,
    length: menuSection.length,
  };
  record.checks.menuSectionRoster17 = record.finalMenuSection.hasRoster && record.finalMenuSection.rosterRows === 17;

  // Deadline fault injection: the provider ignores the signal and never
  // settles. The controller must reject at the deadline, not return a late
  // success. No keepalive is used: the deadline timer is ref'd.
  (container as any).call = originalContainerCall;
  const providers = await importRuntime("lib/multimodal/providers/base.ts");
  providers.registerProvider({ id: "deepseek", call: async () => await new Promise(() => {}) });
  const cancelStart = Date.now();
  const cancelMono = performance.now();
  let cancelError: any = null;
  try {
    await controller.runAgentTurn({
      userId, conversationId, turnId: "offline-current-cancel", channel: "cli",
      deadlineAtMs: Date.now() + 1_500,
      messages: [{ role: "user", content: "再发一张图" }],
      image: { name: "tap-list.jpg", type: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA" },
    });
  } catch (error) {
    cancelError = error;
  }
  const cancelMs = Math.round(performance.now() - cancelMono);
  const memoryAfterCancel = await memoryModule.readShortTermMemory(conversationId, userId);
  record.cancel = {
    code: cancelError?.code ?? null,
    name: cancelError?.name ?? null,
    monotonicMs: cancelMs,
    wallMs: Date.now() - cancelStart,
    withinDeadlinePlusOneSecond: (Date.now() - cancelStart) <= 2_500,
    rejected: cancelError !== null,
    memoryTurnCount: memoryAfterCancel?.recentTurns?.length ?? 0,
    memoryTurnCountBefore: memoryAfterFollowUps?.recentTurns?.length ?? 0,
  };
  record.checks.cancelRejectedWithDeadline = cancelError?.code === "turn_deadline_exceeded";
  record.checks.cancelPromptly = record.cancel.withinDeadlinePlusOneSecond && cancelMs < 2_500;
  record.checks.cancelDidNotWriteMemory = record.cancel.memoryTurnCount === record.cancel.memoryTurnCountBefore;
  globalThis.fetch = originalFetch;
  record.checks.followUpCount = record.followUps.length === questions.length;
  await save();
  console.log(JSON.stringify({
    initial: { ms: record.initial.monotonicMs, candidates: record.initial.candidateCount, route: record.initial.route },
    followUps: record.followUps.map((f: any) => ({ q: f.question, ms: f.monotonicMs, route: f.route, intent: f.intent, textCalls: f.textCalls })),
    cancel: record.cancel,
    checks: record.checks,
  }, null, 2));
} catch (error) {
  record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await save();
  throw error;
} finally {
  process.chdir(originalCwd);
  await rm(stateDir, { recursive: true, force: true });
}
