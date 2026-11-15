# Feishu private-chat acceptance — 2026-11-14

## Status

**BLOCKED on one human action.** The Beer Lens bot is running from this worktree with the fixed code and an established Feishu long connection. No new message was received in the authorized Beer Lens p2p chat during two 30-minute observation windows. No Feishu image reply, no multi-turn reply, and no client-visible timestamp have been claimed as passed.

This is not a code or credential failure: `checkFeishuTrialConfig` reports `ready: true` with the existing Beer Lens app, and the bot log says `Beer Lens 飞书长连接已建立`. The remaining step is a user-sent image (or an explicit IM user authorization for automation).

## Running configuration

- Image: `BEER_VISION_PROVIDER=deepseek`, model `deepseek-flash`, one request per turn, no fallback.
- Text: `BEER_TEXT_PROVIDER=openrouter`, existing `OPENROUTER_API_KEY`, model `deepseek/deepseek-chat` (the old Coding Plan key returns 401; the Ark `LLM_*` entry exceeded 60s on the long knowledge prompt).
- Budget: 60,000 ms including queue; 4,000 ms reply reserve → 56,000 ms agent budget.
- Feishu app: existing Beer Lens app from `/Volumes/SanDisk2TB/beer-lens/.env.local`; no secret printed or copied into the repo.
- Chat scope: the authorized Beer Lens private p2p chat only (the chat that already contains `/mbcb` test messages). No group chat or other user.
- Image: `tests/fixtures/tap-list.jpg`, SHA-256 `e9f24bb22950b20bdcc621a3dcd4fdf5c9461da7a94808941ef061bf78649bc6`; this is the reviewed holdout image, not a private photo.

## Required human action

Send the image to the Beer Lens private chat, then send these five questions one at a time after the first full reply:

1. 我预算100元以内，想要清爽不苦，选哪款？
2. 哪款酒花最香？
3. 哪款是经典款？
4. 第7款多少钱？
5. 为什么推荐第一款？

The watcher records each inbound message `create_time`, each bot reply `create_time`, and the difference (client-visible proxy). The bot writes one `[feishu:turn_timing]` JSON record per inbound message with `queueWaitMs`, `imageDownloadMs`, `agentMs`, `memoryWriteMs`, `replyMs`, `processingMs`, and `firstReplyLatencyMs` on a monotonic clock.

## What is already proven without Feishu transport

- Real reviewed image → 17 candidates → 3 picks → full 17-row reply, server-side 32.0s (`live-deepseek-schema2.json`).
- The reply starts with explicit image boundaries: #5 reflective/blank, #11 brewery ambiguity, #19/#20 cropped (`menu-coverage.ts`, offline replay).
- Real multi-turn content with the active menu: budget 4ms, hops 10.8s, classic 9.7s, price 9ms, why 4.8s (`real-multiturn-report.json`). Deterministic guards prepend menu arithmetic for “最低/最便宜” claims and source caveats for unsourced brewery history; the budget guard is unit-tested against the captured “90元略超预算” counterexample.
- Offline replay keeps 17 rows across all five follow-ups and cancels a non-settling provider at 1.5s (`offline-replay-report.json`).

## What is not proven

- The Feishu WebSocket inbound event for a **user**-sent image in this run.
- The Feishu image download from that message.
- The complete reply's client-visible latency (message timestamp to reply timestamp).
- Whether the Feishu client renders the full text without truncation.

These must be recorded after the human action; until then the 60-second client target remains unverified.

## Observation evidence

- `feishu-watch.json` in the job temp directory: `events=0`, `pollErrors=0` across two 30-minute windows.
- Bot log: connected, no turn timing records.
- `lark-cli auth status`: user identity missing; no user token was extracted or printed. Device authorization was offered but not completed.
