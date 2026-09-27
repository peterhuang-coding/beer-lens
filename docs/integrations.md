# Integrations

## Recommended Shape

Use `/api/agent` as the core Beer Agent endpoint.

Channels such as web chat, Feishu, WeChat, Telegram, or a native app should call the same agent endpoint. This keeps the recommendation logic, benchmark parsing, and taste profile update rules in one place.

## OpenRouter

Set:

```bash
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_VISION_MODEL=google/gemini-2.5-flash
OPENROUTER_ANALYSIS_MODEL=openai/gpt-4o-mini
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_TITLE=Beer Lens
# Optional if Node cannot reach OpenRouter directly:
OPENROUTER_PROXY=http://127.0.0.1:7890
# Optional. Crawler-style per-request timeout in ms. Reference values
# are documented alongside UNTAPPD_TIMEOUT_MS / RATEBEER source flags
# in `.env.example` — keep OpenRouter and crawler timeouts in the same
# order of magnitude so a slow upstream doesn't mask a real error.
OPENROUTER_TIMEOUT_MS=20000
```

Then run:

```bash
npm run dev
```

`/api/agent` will use OpenRouter when `OPENROUTER_API_KEY` is present.

Local CLI demo:

```bash
node scripts/beer-agent-demo.mjs --image ./menu.jpg --text "今天想喝清爽一点，不要太苦"
node scripts/beer-agent-demo.mjs --text "酒单：Other Half Green City, Firestone Pivo Pils"
node scripts/beer-agent-demo.mjs --feedback "我喝了 Green City，4.5 分，会再喝，热带水果，顺滑"
```

The CLI runs a multi-stage chain:

1. Image classification
   - Decides whether the image is `menu`, `tap_list`, `bottle`, `can`, `glass`, `venue`, or `unknown`.
   - Decides whether OCR, label recognition, or visual quality assessment is useful.
2. Beer signal extraction
   - For menu/tap list: extracts beer candidates.
   - For bottle/can: extracts label information and packaging date if visible.
   - For glass: describes visible beer liquid without inventing a beer name.
3. Visual quality assessment
   - Looks for visible risks such as possible oxidation, stale hop/freshness risk, lightstrike risk, low foam, unexpected haze, unexpected darkening, missing date, or packaging damage.
   - These are visual risk hints, not definitive quality claims.
4. Semantic recommendation
   - Combines user intent, extracted beer candidates, visual risk, and the local taste profile.
   - Produces worth score, fit score, top pick, safe pick, explore pick, and avoid/caution pick.

Important: visual oxidation detection is only a risk signal. The agent should say "疑似/有视觉风险", not "一定氧化".

## Feishu

Feishu is a good channel for a first real bot because users can send text and photos from mobile, and the bot can reply in the same chat.

The route is:

```text
POST /api/feishu/events
```

Environment variables:

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
FEISHU_ENCRYPT_KEY=xxx
```

Current support:

- URL challenge verification
- Text message receive
- Image message receive
- Download message image from Feishu
- Pass text/image into `/api/agent`
- Reply in plain text as the bot
- Per-chat conversation memory using `chat_id`
- Manual reset command: `清空`, `重置`, `/reset`
- **快速回执**：HTTP 入口通过 `after()` 安排处理后返回；长连接立即确认事件。
  图片下载、模型调用和回复在同一聊天的队列中串行执行，下一轮等上一轮完成后再读取上下文。
- `/reset` 同时清除当前聊天历史和短期菜单、约束；长期口味记录保留。

Current limitations:

- No message card reply yet
- 队列仅驻留当前进程内存，不是持久化任务系统；进程突然退出时，尚未处理的消息可能丢失
- Verification token is checked, but encrypted event payloads are not decrypted yet

Feishu setup:

1. Create a self-built app in Feishu Open Platform.
2. Enable bot capability.
3. Add message permissions, including receiving messages, getting message images, and sending messages as bot.
4. Configure event subscription URL to your deployed `/api/feishu/events`.
5. Subscribe to the message receive event for bot messages.
6. Publish the app.

Local development needs a public tunnel such as ngrok or a deployed preview URL, because Feishu must call a public HTTPS endpoint.

Important:

- If you enable Feishu event encryption, the current code will reject encrypted payloads.
- For the fastest first integration, keep verification token enabled but turn off event encryption in the Feishu callback settings.

### 飞书长连接试用入口

`npm run feishu:check` 检查 `.env.local` 或应用运行环境中的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`OPENROUTER_API_KEY`，只输出缺失字段名。该检查不验证凭据有效性。

`npm run feishu:bot` 使用官方 SDK 建立长连接，和 HTTP 回调共用 `lib/feishu/handler.ts`。此入口只接收用户私聊；`FEISHU_ALLOWED_OPEN_IDS` 可进一步限定试用用户。收到事件后立即回执，同一聊天串行处理，重复事件去重。

在飞书开放平台为项目自建应用启用机器人，配置私聊消息接收、资源读取和机器人回复权限，订阅 `im.message.receive_v1` 并选择长连接方式。发布后将可用范围限定为试用人员。参见[官方长连接说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode)。

每个应用只运行一个本项目接收进程，使用可写、持久化的 `data/` 目录。进程需持续运行才能接收新消息；当前工作区的临时进程不等同于长期托管。长连接不经过 HTTP 回调的加密分支。

飞书沿用 Agent Controller 的 OpenRouter 链路。Web `/api/chat` 的 `LLM_*` 配置不能替代这里的 `OPENROUTER_API_KEY`；视觉管线的模型设置仍由项目 `data/pipeline-config.json` 决定。

试用先私聊发送“你好”和“你能帮我做什么？”，再发真实酒单并追问预算、编号。接入检查与真实回答质量分别验收；预算、实体抽取、否定编号及容量更新已有离线修复回归，真实模型与飞书会话质量仍需单独验收。见[本次改动与验证](beer-lens/改动与验证.md)。

## Provider Priority

The current provider order is:

1. `BEER_AGENT_API_URL` if set
2. OpenRouter if `OPENROUTER_API_KEY` is set
3. Local mock provider
