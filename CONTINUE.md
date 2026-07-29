# Beer Lens Crawler — Session Handoff

> Last updated: 2026-07-29 15:30 UTC by Claude (session 1)
> Purpose: 接力说明，让下一 session 直接接着干，不用从头调研。

## 当前状态 (session 1 收尾)

- **branch**: `feat/always-on-crawler` @ latest commit
- **worktree**: `/Volumes/SanDisk2TB/beer-lens/.claude/worktrees/feat-always-on-crawler/`
- **PR**: https://github.com/peterhuang-coding/beer-lens/pull/2 (draft)

| 指标 | session 0 | session 1 | Δ |
|---|---|---|---|
| beer_cache verified | 28 | **32** | +4 |
| warm_list coverage | 28/30 | **30/30** | +2 (gap closed) |
| inspector verdict | DEGRADED | **OK** | 升级 |
| crawl-log entries | 0 | 5 (2 verified + 3 skipped) | — |

## 已抓 (session 1)

```
✅ Sleep (HopFan Brewing) — ABV 6.5%, style Imperial IPA (NEIPA)
   sources: hopfan.com/beer/15426, untappd.com, ratebeer.com
✅ Bird Land NE IPA (Master Gao Brewing Co. of Nanjing)
   ABV 5.0%, IBU 27, rating 3.40/5 (465 ratings on jiuhuar.com)
✅ Burning HDHC (Crazy Bear Industry) — seed-data direct cache
✅ Hop Roulade (YE Brewing) — seed-data direct cache
✅ Hop Roulade - Australian Hops (YE Brewing) — seed-data direct cache
✅ DDH West Coast (Crazy Bear Industry) — seed-data direct cache
⏭ Ritual Under the Stars (Fever Ales) — skipped, no ABV found
⏭ Wan - DHDHC (Crazy Bear Industry) — skipped, no ABV found
⏭ Star Navigator: Nelson Sauvin (Fever Ales) — skipped, no ABV found
```

## 跳过的 3 个怎么下次处理

Fever Ales × 2 + Wan-DHDHC 信息源不足（seed 只有 rating 没有 ABV，WebSearch 也没命中）。下次 session 可以：

1. **不同搜索角度**：试试 `site:untappd.com "Fever Ales"` 或 `jiuhuar.com/craftbeer/Fever`
2. **看 BreweryDB / BeerAdvocate live API**（之前审计标记为缺失，可装）
3. **直接入 untappd_cache 而非 beer_cache**（untappd_cache 允许 unverified=0）

## 下次 session 怎么启动

```bash
cd /Volumes/SanDisk2TB/beer-lens/.claude/worktrees/feat-always-on-crawler

# 1. 看当前状态
node scripts/skill-inspector.mjs --print | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['summary'])"

# 2. 拉下一批目标（warm_list 已 30/30，会 fallback 到 high_rated 国际啤酒）
node scripts/always-on-crawler.mjs --round 2 --limit 30 --output data/round-2.json

# 3. 或继续抓 CN 种子剩余的（跳过的 3 个 + 其他缺字段的）
node scripts/always-on-crawler.mjs --round 2 --limit 30 \
  --breweries "Fever Ales,Crazy Bear Industry,YE Brewing,Jing-A,Master Gao,NO.18" \
  --output data/round-2.json

# 4. 看到 round-2.json 后，逐条 WebSearch + cache

# 5. 起 Skill Hub 持续观测（端口 8888，浏览器打开看面板）
PORT=8888 nohup node scripts/skill-hub-server.mjs > /tmp/skill-hub.log 2>&1 &
```

## WebSearch 节省小技巧

- 每条 2-3 次 WS 已够（英文搜 + 中文搜 + BreweryDB/Hopfan DB 选一个）
- 200 WS/session 预算，约 60-80 条啤酒/session
- 每次 session 目标：先跑 inspector 看状态，再 round N，最后 commit + push

## 已实现的能力（基础设施已全到位）

- ✅ `scripts/always-on-crawler.mjs` — 目标清单生成
- ✅ `scripts/skill-hub-server.mjs` — 可视化面板（端口 8888）
- ✅ `scripts/skill-inspector.mjs` — 5 阶段巡检 + ReAct proposal
- ✅ `scripts/agent.mjs` — 单入口（支持 --crawler / --inspector / --hub / --query）
- ✅ `.claude/skills/beer-lens.md` v6.0 — Always-On Mode + Skill Hub 文档
- ✅ 测试 221/221 ✅
- ✅ PR 已开（draft 状态）

## 不需要再做的事

- ❌ 调研第三方 crawler skill（已确认 WebSearch 是最优解）
- ❌ 装 Playwright / Firecrawl / browser-mcp（Untappd Cloudflare 一样过不去）
- ❌ 写新的架构层（agent.mjs 就是单入口）

## 已知坑

- `ALL_PROXY=socks5://127.0.0.1:7897` 拦截 localhost → curl 需 `--noproxy '*'`
- git http proxy 在 `127.0.0.1:7890` (端口不通)；要用 SOCKS5 `127.0.0.1:7897`：
  `git -c http.proxy=socks5h://127.0.0.1:7897 -c https.proxy=socks5h://127.0.0.1:7897 push`
- chinese-craft-beers.json 60% 缺字段（这是 seed 数据，下一轮可补）
- `dedupeAndMerge` 在中文括号 brewery 上有 bug（"YE Brewing" vs "YE Brewing (野鹅微醺)" 没去重）— 待修