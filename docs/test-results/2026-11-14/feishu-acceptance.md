# Feishu private-chat acceptance — 2026-11-15

## Status

**PARTIAL.** A real user image was received in the authorized Beer Lens p2p chat and the full first-turn reply was delivered. The 5-question multi-turn and the cleaned-up (currency-fixed) image replay are still pending.

This is no longer a blocked-connection status: the bot received a user image, downloaded it, ran the real DeepSeek vision pipeline, persisted the menu, and sent a complete reply.

## Real attempts

| Attempt | User image SHA | Result | Server timing | Client-visible proxy |
|---|---|---|---|---|
| 1 | matches reviewed fixture | failed: `vision call canceled/402` | 4.36s | 4.89s |
| 2 | matches reviewed fixture | failed: same path | 4.54s | 5.02s |
| 3 | matches reviewed fixture | **ok: 17 rows, full reply** | 19.70s | **20.20s** |

The first two failures were traced to the `.env.local` DeepSeek key having **zero balance (HTTP 402)**, not to image content. The bot was restarted with a balance-checked, already-authorized DeepSeek key. The third attempt succeeded.

The actual image SHA-256 was `e9f24bb22950b20bdcc621a3dcd4fdf5c9461da7a94808941ef061bf78649bc6`, exactly the reviewed `tests/fixtures/tap-list.jpg`; no private photo was sent.

## Turn timing (attempt 3)

Bot `[feishu:turn_timing]` monotonic record:

- queueWait 0.5ms
- imageDownload 879.9ms
- agent 18,221.7ms
- memoryWrite 0.7ms
- reply 588.9ms
- firstReplyLatency 19,700.8ms
- result `ok`, replySucceeded true

Client-visible proxy from Feishu `create_time`: user image 1794720633486 → bot reply 1794720653686 = **20,200ms**, within the 60s target.

## What the reply contained

- 17 menu rows (the tap-list holdout; #5 reflective/blank; #19/#20 cropped were surfaced in the image-boundary note).
- 3 picks with price/volume/unit-price/tradeoff.
- Full per-row style reading; no fabricated ratings or market quotes for the holdout.
- The reply was generated **before** the currency-display fix, so some prices showed `unknown` instead of `元`; the bot has since been fixed (`offerText` infers `¥/元` from OCR evidence). A clean image replay is still pending.

## Not yet tested

- The 5 text follow-ups in Feishu (budget, bitterness, hops, classic, price). The 17-row short-term menu is persisted; the bot is running with the fixed supplement and guards.
- A clean image reply after the currency fix (optional if the existing 20.2s image evidence is accepted).
- Group chats, other users, deployment.

## Evidence

- `feishu-watch.json` (job temp): messages, reply match, client latency.
- Bot log: `[feishu:turn_timing]` record above.
- OCR/vision root cause: a 402 balance failure and a separate truncated-JSON/0-item bug; fixed by `thinking: disabled` and JSON salvage. Real diagnostic after fix: 12.5s, 17 items.
