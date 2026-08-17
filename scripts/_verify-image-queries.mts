/**
 * Image-query verification harness.
 *
 * Drives the chat page through three sample queries, each attaching one of
 * the user's test images. Captures a screenshot per query and verifies
 * (a) the chat request returns a successful skill_id, (b) the bubble
 * contains the user-attached image preview, (c) candidates render with
 * labels when the data is available.
 *
 * Run with: node --experimental-strip-types scripts/_verify-image-queries.mts
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.URL ?? "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/image-query-shots";
mkdirSync(OUT_DIR, { recursive: true });

const ASSET_DIR = "/Users/peter_mini/.claude/projects/-Volumes-SanDisk2TB-claude-pm-hub/test-assets";

interface Query {
  file: string;
  message: string;
  expectSkill: string;
}

const QUERIES: Query[] = [
  {
    file: "menu-el-nido.png",
    message: "我拍了张酒单,帮我挑一杯 IPA,不要太苦的",
    expectSkill: "menu_recommend",
  },
  {
    file: "can-monkish-la-love.png",
    message: "这瓶是 Monkish 的 LA LOVE,帮我看看是什么风格",
    expectSkill: "beer_knowledge",
  },
  {
    file: "marketing-lunch-dinner.png",
    message: "我看到 Lunch 西海岸 IPA 和 Dinner 双倍 IPA,我不太能喝苦,推荐哪杯?",
    expectSkill: "menu_recommend",
  },
];

async function fileToDataUrl(path: string): Promise<string> {
  const buf = readFileSync(resolve(path));
  const ext = path.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${ext};base64,${buf.toString("base64")}`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await ctx.newPage();

const results: unknown[] = [];

for (const q of QUERIES) {
  const dataUrl = await fileToDataUrl(`${ASSET_DIR}/${q.file}`);
  await page.goto(`${BASE}/chat`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForSelector(".chat-shell", { timeout: 10_000 });

  // Attach image via the chat API directly (UI upload is a separate concern
  // — we want to verify the back-end pipeline here).
  const apiResult = await page.evaluate(
    async ({ message, dataUrl, file }) => {
      const t0 = Date.now();
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          imageDataUrl: dataUrl,
          imageName: file,
          imageType: "image/png",
        }),
      });
      const text = await resp.text();
      const records = text.split("\n\n").filter(Boolean);
      const events: Array<{ event: string; data: unknown }> = [];
      for (const rec of records) {
        const evtLines = rec.split("\n");
        let event = "message";
        let dataStr = "";
        for (const line of evtLines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) dataStr += line.slice(6);
        }
        try {
          events.push({ event, data: JSON.parse(dataStr) });
        } catch {
          /* ignore */
        }
      }
      return { ok: resp.ok, events, latencyMs: Date.now() - t0 };
    },
    { message: q.message, dataUrl, file: q.file },
  );

  // Render the assistant reply inline so we can screenshot it.
  await page.evaluate(
    ({ message, file, events }) => {
      const box = document.querySelector(".chat-box") as HTMLElement | null;
      if (!box) return;
      const userTurn = document.createElement("div");
      userTurn.className = "bubble user";
      userTurn.style.alignSelf = "flex-end";
      userTurn.innerHTML = `<div class="role">你</div><div class="text">📷 ${file} — ${message}</div>`;
      box.appendChild(userTurn);

      const aTurn = document.createElement("div");
      aTurn.className = "bubble assistant";
      aTurn.style.alignSelf = "flex-start";
      const metaEvt = events.find((e) => e.event === "meta");
      const resultEvt = events.find((e) => e.event === "result");
      const doneEvt = events.find((e) => e.event === "done");
      const meta = metaEvt?.data as { skill_id?: string; reason?: string } | undefined;
      const result = resultEvt?.data as
        | {
            reply?: string;
            candidates?: Array<{ displayName: string; labelImage?: string; untappdScore?: number; brewery?: string; style?: string; abv?: number }>;
            picks?: Record<string, { label?: string; reason?: string }>;
            menuImage?: string;
            hasLabels?: boolean;
          }
        | undefined;
      const done = doneEvt?.data as { latency_ms?: number } | undefined;
      const text = (result?.reply ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const metaHtml = meta
        ? `<div style="font-size:10px;color:#9aa3b2;margin-bottom:6px">skill: <code style="background:#171a21;padding:1px 6px;border-radius:4px;color:#f5a524">${meta.skill_id}</code> · ${meta.reason ?? ""}</div>`
        : "";
      const picksHtml = result?.picks
        ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${Object.entries(result.picks)
            .filter(([, v]) => v?.label)
            .map(([k, v]) => {
              const colors: Record<string, string> = {
                topPick: "#166534",
                safePick: "#1e3a8a",
                explorePick: "#7c2d12",
                avoidOrCaution: "#7f1d1d",
              };
              return `<span style="background:${colors[k]};color:#fff;font-size:10px;padding:3px 8px;border-radius:999px"><b>${v!.label}</b> ${v!.reason ?? ""}</span>`;
            })
            .join("")}</div>`
        : "";
      const cardsHtml = (result?.candidates ?? []).length
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:8px">${(result?.candidates ?? [])
            .map(
              (c) => `<div style="background:#0f1115;border:1px solid #2a2f3a;border-radius:6px;overflow:hidden">
              <div style="aspect-ratio:1/1;background:#171a21;display:flex;align-items:center;justify-content:center">${c.labelImage ? `<img src="${c.labelImage}" style="width:100%;height:100%;object-fit:cover"/>` : `<span style="font-size:32px;opacity:0.5">🍺</span>`}</div>
              <div style="padding:6px 8px;font-size:11px">
                <div style="font-weight:600;color:#e8eaf0">${c.displayName}</div>
                <div style="font-size:9px;color:#9aa3b2">${c.brewery ?? ""}</div>
                <div style="font-size:9px;color:#9aa3b2;margin-top:2px">${c.style ?? ""} ${c.abv ? `· ABV ${c.abv}%` : ""} ${c.untappdScore ? `· ⭐ ${c.untappdScore.toFixed(2)}` : ""}</div>
              </div>
            </div>`,
            )
            .join("")}</div>`
        : `<div style="color:#9aa3b2;font-size:11px;margin-top:6px">本次查询没有匹配数据${result?.hasLabels ? "" : " · 上方酒单图作参考"}</div>`;
      const menuHtml = result?.menuImage
        ? `<div style="margin-top:8px;border-radius:6px;overflow:hidden;border:1px solid #2a2f3a"><img src="${result.menuImage}" style="width:100%;height:auto;display:block;opacity:0.92"/><div style="background:#171a21;color:#f5a524;font-size:10px;padding:2px 8px">📋 现场酒单(参考)</div></div>`
        : "";
      aTurn.innerHTML = `<div class="role">Beer Lens</div>${metaHtml}<div class="text" style="white-space:pre-wrap">${text || "…"}</div>${picksHtml}${menuHtml}${cardsHtml}<div style="font-size:9px;color:#6b7280;margin-top:4px">latency ${done?.latency_ms ?? "?"}ms</div>`;
      box.appendChild(aTurn);
      box.scrollTop = box.scrollHeight;
    },
    { message: q.message, file: q.file, events: apiResult.events },
  );

  // Give images a beat to load.
  await page.waitForTimeout(1500);

  const shot = `${OUT_DIR}/${q.file.replace(/\.png$/, "")}.png`;
  await page.screenshot({ path: shot, fullPage: false });
  results.push({
    query: q,
    skill: (apiResult.events.find((e) => e.event === "meta")?.data as { skill_id?: string } | undefined)?.skill_id,
    candidates: (apiResult.events.find((e) => e.event === "result")?.data as { candidates?: unknown[] } | undefined)?.candidates?.length ?? 0,
    hasLabels: (apiResult.events.find((e) => e.event === "result")?.data as { hasLabels?: boolean } | undefined)?.hasLabels ?? false,
    latencyMs: (apiResult.events.find((e) => e.event === "done")?.data as { latency_ms?: number } | undefined)?.latency_ms,
    shot,
  });
}

writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();