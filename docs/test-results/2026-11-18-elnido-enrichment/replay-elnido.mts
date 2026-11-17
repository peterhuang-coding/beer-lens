import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = "/Volumes/SanDisk2TB/beer-lens-feishu-harness";
const OCR = "/Users/peter_mini/.claude/jobs/19ecd6ac/tmp/elnido-menu-ocr.json";
const OUT = process.argv[2];
if (!OUT) throw new Error("output path required");

const ocr = JSON.parse(await readFile(OCR, "utf8"));
if (!Array.isArray(ocr.extracted?.items) || ocr.extracted.items.length === 0) throw new Error("OCR items missing");

process.env.BEER_VISION_PROVIDER = "deepseek";
process.env.BEER_TEXT_PROVIDER = "openrouter";
process.env.DEEPSEEK_API_KEY = "offline-replay-key";
process.env.OPENROUTER_API_KEY = "offline-replay-key";
process.env.BEER_FIRST_REPLY_BUDGET_MS = "60000";

const stateDir = await mkdtemp(path.join(tmpdir(), "beer-lens-elnido-replay-"));
const originalCwd = process.cwd();
const report: Record<string, any> = { items: ocr.extracted.items.length, initial: null, candidates: [], checks: {} };
async function copyState(relative: string, optional = false) {
  const target = path.join(stateDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  try { await copyFile(path.join(ROOT, relative), target); }
  catch (error) { if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
try {
  for (const relative of [
    ".beer-data/lookup.py", ".beer-data/beer.db", "data/beer_cache.json",
    "data/events/mbcb-2026-red.json", "data/menus/elnido-2026-10.json",
    "data/menus/elnido-2026-10-additions.json", "data/menus/elnido-2026-11.json",
  ]) await copyState(relative, relative === "data/beer_cache.json");
  await writeFile(path.join(stateDir, "data", "pipeline-config.json"),
    JSON.stringify({ memoryExperiment: { enabled: false } }, null, 2) + "\n");
  process.chdir(stateDir);
  const importRuntime = (relative: string) => import(pathToFileURL(path.join(ROOT, relative)).href);
  const { container } = await importRuntime("lib/multimodal/container.ts");
  (container as any).call = async () => ({
    raw: JSON.stringify({ imageContext: ocr.imageContext, extracted: ocr.extracted, visualQuality: ocr.visualQuality }),
    parsed: { imageContext: ocr.imageContext, extracted: ocr.extracted, visualQuality: ocr.visualQuality },
    fromCache: true, provider: "captured", model: "deepseek-flash", durationMs: 0, attempts: [],
  });
  const controller = await importRuntime("lib/agent/controller.ts");
  const started = performance.now();
  const response = await controller.runAgentTurn({
    userId: "elnido-replay-user",
    conversationId: "elnido-replay-conversation",
    turnId: "elnido-replay-1",
    channel: "cli",
    deadlineAtMs: Date.now() + 56_000,
    messages: [{ role: "user", content: "请解读整张酒单，并给我 2–3 个选择。我偏好清爽、不太苦的啤酒，也关心价格。" }],
    image: { name: "elnido.png", type: "image/png", dataUrl: "data:image/png;base64,AAAA" },
  });
  report.initial = {
    monotonicMs: Math.round(performance.now() - started),
    candidateCount: response.candidates.length,
    route: response.debug?.route,
    warnings: response.debug?.warnings ?? [],
    reply: response.reply,
  };
  report.candidates = response.candidates.map(candidate => ({
    menuIndex: candidate.menuIndex,
    displayName: candidate.displayName,
    brewery: candidate.brewery,
    identityStatus: candidate.dossier?.identity?.identityStatus ?? null,
    rating: candidate.dossier?.rating?.value ?? null,
    ratingSource: candidate.dossier?.rating?.url ?? null,
    hops: candidate.dossier?.hops?.value ?? null,
    sensory: candidate.dossier?.sensory?.value ?? null,
    styleLayer: candidate.dossier?.styleLayer?.label ?? null,
  }));
  const sourced = report.candidates.filter((c: any) => c.identityStatus === "confirmed" && c.rating);
  const hops = report.candidates.filter((c: any) => Array.isArray(c.hops) && c.hops.length > 0);
  report.checks = {
    beerRows19: response.candidates.length === 19,
    sourcedRowsAtLeast13: sourced.length >= 13,
    hopsRowsAtLeast7: hops.length >= 7,
    unresolvedRowsExplicitlyUnknown: report.candidates.some((c: any) => c.identityStatus === "unmatched"),
    replyMentionsSourcedRating: /4\.05|4\.09|3\.41|评分/.test(response.reply),
    replyMentionsHops: /Nectaron|Citra|Mosaic|Simcoe|Chinook/.test(response.reply),
  };
  await writeFile(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    initial: { ms: report.initial.monotonicMs, candidates: report.initial.candidateCount, warnings: report.initial.warnings },
    sourced: sourced.map((c: any) => `${c.menuIndex}:${c.displayName} ${c.rating.score}/${c.rating.count}`),
    hops: hops.map((c: any) => `${c.menuIndex}:${c.displayName} ${c.hops.join(",")}`),
    unresolved: report.candidates.filter((c: any) => c.identityStatus !== "confirmed").map((c: any) => `${c.menuIndex}:${c.displayName}`),
    checks: report.checks,
  }, null, 2));
} finally {
  process.chdir(originalCwd);
  await rm(stateDir, { recursive: true, force: true });
}
