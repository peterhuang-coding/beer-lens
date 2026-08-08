#!/usr/bin/env node
// scripts/dump-untappd-cookies.mjs
//
// 通过 Chrome DevTools Protocol (CDP) 连到你本机已登录的 Chrome，
// 直接读 Untappd 的 3 条 session cookie，打印 `export` 命令到 stdout。
//
// 安全保证:
//   - cookie 值只走 CDP -> 当前进程内存 -> stdout (你的终端)
//   - 不写文件 / 不传 sub-agent / 不进聊天 / 不进 log
//   - 只输出 3 条具名 cookie，多余的不打印
//
// 用法:
//   1. 退出 Chrome:    osascript -e 'quit app "Google Chrome"'
//   2. 重启 Chrome:    open -a "Google Chrome" --args --remote-debugging-port=9222
//   3. 登录 untappd.com (新窗口里随便开一下,等看到已登录状态)
//   4. 跑这个脚本:     node scripts/dump-untappd-cookies.mjs
//   5. 把输出 eval:   eval "$(node scripts/dump-untappd-cookies.mjs)"
//   6. 跑爬虫:         node scripts/run-sanity-50.mjs --limit 3
//
// 注意: 如果 Chrome 已在跑且没开 debug 端口，必须先关再重启。

import process from "node:process";
import { execFileSync } from "node:child_process";

const CDP_HTTP = "http://localhost:9222";
const TARGET_DOMAIN = "untappd.com";
const WANTED = ["untappd_session_t", "untappd_user_v3_e", "untappd_traits"];

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const log = {
  info: (m) => console.error(`${GREEN}✓${RESET} ${m}`),
  warn: (m) => console.error(`${YELLOW}⚠${RESET} ${m}`),
  err: (m) => console.error(`${RED}❌${RESET} ${m}`),
  hint: (m) => console.error(`${DIM}  ${m}${RESET}`),
};

async function cdpFetch(path) {
  const r = await fetch(`${CDP_HTTP}${path}`);
  if (!r.ok) throw new Error(`CDP ${path} -> ${r.status}`);
  return r.json();
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stderr.write(
      `\n${YELLOW}→${RESET} 在那个标签里登录 Untappd，登录后按回车继续...\n`,
    );
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function main() {
  // ── 1. 连一下 CDP，看 Chrome 是否带 debug 端口 ─────────────────────────
  let version;
  try {
    version = await cdpFetch("/json/version");
  } catch (e) {
    log.err(`Chrome 远程调试端口 ${CDP_HTTP} 不通: ${e.message}`);
    log.hint("先关 Chrome 再用 debug 端口重启:");
    log.hint(`  osascript -e 'quit app "Google Chrome"'`);
    log.hint(`  open -a "Google Chrome" --args --remote-debugging-port=9222`);
    log.hint("重启后在新窗口登录 untappd.com，再跑这个脚本");
    process.exit(2);
  }
  log.info(`已连 Chrome: ${version.Browser || version.browser}`);

  // ── 2. 找现有 untappd.com 标签，没有就新建 ─────────────────────────────
  const targets = await cdpFetch("/json/list");
  let untappdTarget = targets.find(
    (t) =>
      t.type === "page" &&
      typeof t.url === "string" &&
      t.url.includes(TARGET_DOMAIN),
  );

  if (!untappdTarget) {
    log.warn(`没找到 ${TARGET_DOMAIN} 标签，让 Chrome 新开一个...`);
    try {
      // macOS 原生命令: open -a "App" URL  → 在指定 app 里开新标签
      // 绕开 CDP 的 new-tab HTTP 端点 (Chrome 150+ 该端点只接 PUT, GET 会 405)
      execFileSync("open", ["-a", "Google Chrome", `https://${TARGET_DOMAIN}`], {
        stdio: "ignore",
      });
    } catch (e) {
      log.err(`open 命令失败: ${e.message}`);
      log.hint(`手动在 Chrome 里打开 https://${TARGET_DOMAIN} 再重跑`);
      process.exit(2);
    }

    // 等新标签出现在 CDP 列表里 (最多 10s)
    let found = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const list = await cdpFetch("/json/list");
      found = list.find(
        (t) =>
          t.type === "page" &&
          typeof t.url === "string" &&
          t.url.includes(TARGET_DOMAIN),
      );
      if (found) break;
    }

    if (!found) {
      log.err(`Chrome 没开起 ${TARGET_DOMAIN} 标签 (10s 超时)`);
      log.hint(`在 Chrome 里手动开 https://${TARGET_DOMAIN} 再重跑这个脚本`);
      process.exit(3);
    }

    untappdTarget = found;
    log.info(`新标签: ${untappdTarget.url}`);
    await waitForEnter();
  } else {
    log.info(`复用现有标签: ${untappdTarget.url}`);
  }

  // ── 3. WS 连过去，发 CDP 命令 ─────────────────────────────────────────
  const ws = new WebSocket(untappdTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket 握手失败"));
    setTimeout(() => reject(new Error("WebSocket 超时 (10s)")), 10000);
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message} (${m.error.code})`));
      else resolve(m.result);
    }
  };

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

  // ── 4. 拿所有 untappd.com 的 cookie ──────────────────────────────────
  const { cookies } = await send("Network.getCookies", {
    domains: [TARGET_DOMAIN],
  });
  ws.close();

  // ── 5. 只留 3 条，其余不打印 ──────────────────────────────────────────
  const picked = new Map();
  for (const c of cookies || []) {
    if (WANTED.includes(c.name)) picked.set(c.name, c.value);
  }

  const missing = WANTED.filter((n) => !picked.has(n));
  if (missing.length === WANTED.length) {
    log.err(`3 条 cookie 一条都没拿到 — 当前 Chrome 未登录 untappd.com`);
    log.hint(`在标签里登录后再试，或确认 cookies 没被手动清`);
    process.exit(3);
  }
  if (missing.length) {
    log.warn(`缺这些: ${missing.join(", ")} — 不影响其他条，照常输出`);
  }

  const header = WANTED.filter((n) => picked.has(n))
    .map((n) => `${n}=${picked.get(n)}`)
    .join("; ");

  // ── 6. 只把 export 命令打到 stdout（其他都走 stderr） ─────────────────
  // eval "$(...)" 会捕获 stdout，stderr 给用户看提示
  console.log(`export UNTAPPD_DEV_COOKIE='${header}'`);
}

main().catch((e) => {
  log.err(e.message);
  process.exit(1);
});