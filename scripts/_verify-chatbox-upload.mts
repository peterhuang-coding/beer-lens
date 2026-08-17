/**
 * Smoke-test the new image-upload UI in ChatBox:
 *  1. Open /chat
 *  2. Use the 📎 file input to attach one of the test images
 *  3. Confirm the attach-strip preview renders
 *  4. Type a message, submit, wait for the assistant reply
 *  5. Screenshot — expect: (a) 📎 strip visible (b) user bubble with attached
 *     image preview (c) assistant bubble with skill_id + reply
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.URL ?? "http://localhost:3000";
const OUT = "/tmp/image-query-shots/chatbox-upload.png";
mkdirSync("/tmp/image-query-shots", { recursive: true });

const ASSET = "/Users/peter_mini/.claude/projects/-Volumes-SanDisk2TB-claude-pm-hub/test-assets/can-monkish-la-love.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await ctx.newPage();

const logs: string[] = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`${BASE}/chat`, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForSelector(".chat-shell", { timeout: 10_000 });

// 1. Confirm the 📎 button exists
const attachBtn = await page.locator(".chat-input .attach-btn").first();
if (!(await attachBtn.isVisible())) throw new Error("📎 button not rendered");

// 2. Set the file via the hidden input
const fileInput = page.locator('.chat-input input[type="file"]');
await fileInput.setInputFiles(ASSET);

// 3. Wait for the attach-strip to render the preview
await page.waitForSelector(".attach-strip img", { timeout: 5_000 });

// 4. Type the question and send
await page.fill(".chat-input input:not([type=file])", "这瓶是什么酒?");
await page.click('.chat-input button[type="submit"]');

// 5. Wait for status-idle (signals done)
await page.waitForFunction(
  () => {
    const s = document.querySelector(".status");
    return s && s.classList.contains("status-idle");
  },
  { timeout: 30_000 },
);

// 6. Wait for the user bubble's attachment preview image to actually load
await page.waitForFunction(
  () => {
    const imgs = document.querySelectorAll(".attach-preview img");
    return imgs.length > 0 && Array.from(imgs).every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0);
  },
  { timeout: 10_000 },
);

// 7. Capture — check that user bubble contains the preview AND the assistant bubble rendered a reply
const userHasPreview = await page.locator(".bubble.user .attach-preview").count();
const assistantHasSkill = await page.locator(".bubble.assistant .route code").count();
const assistantReplyText = await page.locator(".bubble.assistant .text").last().innerText();

await page.screenshot({ path: OUT, fullPage: false });

console.log(JSON.stringify({
  attachBtnVisible: await attachBtn.isVisible(),
  stripPreviewCount: await page.locator(".attach-strip img").count(),
  userHasPreview,
  assistantHasSkill,
  assistantReplyText: assistantReplyText.slice(0, 200),
  shot: OUT,
  logs: logs.slice(-10),
}, null, 2));

await browser.close();