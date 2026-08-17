/**
 * Drive the 3 user-provided images through the ChatBox UI (📎 button),
 * capturing a screenshot per query.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.URL ?? "http://localhost:3000";
const OUT_DIR = "/tmp/image-query-shots";
mkdirSync(OUT_DIR, { recursive: true });

const ASSETS = [
  {
    file: "menu-el-nido.png",
    message: "这酒单帮我挑一杯 IPA,不要太苦",
    shot: `${OUT_DIR}/ui-1-menu-el-nido.png`,
  },
  {
    file: "can-monkish-la-love.png",
    message: "这瓶是什么酒?",
    shot: `${OUT_DIR}/ui-2-monkish-la-love.png`,
  },
  {
    file: "marketing-lunch-dinner.png",
    message: "Lunch 和 Dinner 哪个适合我?我不爱苦",
    shot: `${OUT_DIR}/ui-3-lunch-dinner.png`,
  },
];

const ASSET_DIR = "/Users/peter_mini/.claude/projects/-Volumes-SanDisk2TB-claude-pm-hub/test-assets";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });

interface QueryResult {
  file: string;
  message: string;
  skill: string | null;
  reply: string;
  shot: string;
}

const results: QueryResult[] = [];

for (const q of ASSETS) {
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(`${BASE}/chat`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForSelector(".chat-shell", { timeout: 10_000 });

  // Attach the file via the hidden input
  await page.locator('.chat-input input[type="file"]').setInputFiles(`${ASSET_DIR}/${q.file}`);
  await page.waitForSelector(".attach-strip img", { timeout: 5_000 });

  // Fill the question and submit
  await page.fill('.chat-input input:not([type=file])', q.message);
  await page.click('.chat-input button[type="submit"]');

  // Wait for the assistant bubble to accumulate text — this is more robust
  // than watching .status (which can stay in error if the SSE stream is
  // truncated). OCR + LLM vision paths can take 30-90s.
  await page.waitForFunction(
    () => {
      const bubbles = document.querySelectorAll(".bubble.assistant .text");
      const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
      return !!last && last.innerText.trim().length > 4;
    },
    undefined,
    { timeout: 120_000, polling: 500 },
  );

  // Wait a beat for the user-bubble preview image to load
  await page.waitForFunction(
    () => {
      const imgs = document.querySelectorAll(".attach-preview img");
      return imgs.length > 0 && Array.from(imgs).every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0);
    },
    { timeout: 10_000 },
  );

  const skill = await page.locator(".bubble.assistant .route code").first().innerText().catch(() => null);
  const reply = await page.locator(".bubble.assistant .text").last().innerText().catch(() => "");

  await page.screenshot({ path: q.shot, fullPage: false });

  results.push({ file: q.file, message: q.message, skill, reply: reply.slice(0, 300), shot: q.shot });
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();