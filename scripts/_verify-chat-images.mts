/**
 * Headless smoke test: open /chat, send a message that triggers a real
 * recommend path (with label images), wait for the assistant reply + beer
 * cards to render, then save a screenshot.
 *
 * Used to verify the chat-image pipeline end-to-end after wiring
 * /api/chat to emit candidates with labelImage URLs.
 */
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const URL = process.env.URL ?? "http://localhost:3000/chat";
const PROMPT = process.env.PROMPT ?? "推荐 Pliny the Elder";
const OUT = process.env.OUT ?? "/tmp/chat-verify.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const logs: string[] = [];
page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForSelector(".chat-shell", { timeout: 10_000 });

// Drive the chat box
await page.fill('input[placeholder*="说点什么"]', PROMPT);
await page.press('input[placeholder*="说点什么"]', "Enter");

// Wait for status to flip back to idle (signals done)
await page.waitForFunction(
  () => {
    const s = document.querySelector(".status");
    return s && s.classList.contains("status-idle");
  },
  { timeout: 30_000 },
);

// Wait for any candidate card to appear (label-driven beer card)
const cardCount = await page.locator(".bcard").count();

// Wait for the first beer-card image to actually load (Untappd CDN can be slow).
let cardImgOk: { src: string | null; naturalWidth: number; naturalHeight: number } | null = null;
try {
  await page.waitForFunction(
    () => {
      const img = document.querySelector(".bcard img") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    },
    { timeout: 15_000 },
  );
  cardImgOk = await page.locator(".bcard img").first().evaluate((img) => ({
    src: img.getAttribute("src"),
    naturalWidth: (img as HTMLImageElement).naturalWidth,
    naturalHeight: (img as HTMLImageElement).naturalHeight,
  }));
} catch {
  // fall through — will report naturalWidth=0 below
  cardImgOk = await page
    .locator(".bcard img")
    .first()
    .evaluate((img) => ({
      src: img.getAttribute("src"),
      naturalWidth: (img as HTMLImageElement).naturalWidth,
      naturalHeight: (img as HTMLImageElement).naturalHeight,
    }))
    .catch(() => null);
}
const menuImgOk = await page
  .locator(".menu-img img")
  .first()
  .evaluate((img) => ({
    src: img.getAttribute("src"),
    naturalWidth: (img as HTMLImageElement).naturalWidth,
    naturalHeight: (img as HTMLImageElement).naturalHeight,
  }))
  .catch(() => null);

await page.screenshot({ path: OUT, fullPage: false });

await writeFile(
  OUT.replace(/\.png$/, ".json"),
  JSON.stringify(
    {
      prompt: PROMPT,
      cardCount,
      cardImg: cardImgOk,
      menuImg: menuImgOk,
      logs: logs.slice(-30),
    },
    null,
    2,
  ),
);

await browser.close();

if (!cardImgOk || cardImgOk.naturalWidth === 0) {
  console.error("FAIL: no label image rendered");
  process.exit(1);
}
console.log(`OK: ${cardCount} card(s), label=${cardImgOk.naturalWidth}x${cardImgOk.naturalHeight}, menu=${menuImgOk?.naturalWidth ?? "n/a"}x${menuImgOk?.naturalHeight ?? "n/a"}`);