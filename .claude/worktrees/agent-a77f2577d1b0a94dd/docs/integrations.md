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

Current limitations:

- No message card reply yet
- No async queue yet for long-running model calls
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

## Provider Priority

The current provider order is:

1. `BEER_AGENT_API_URL` if set
2. OpenRouter if `OPENROUTER_API_KEY` is set
3. Local mock provider
