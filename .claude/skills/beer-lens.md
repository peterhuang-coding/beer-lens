---
name: beer-lens
description: >-
  Live beer data harness. Uses WebSearch to find real-time beer ratings,
  ABV, style, brewery info from Untappd/BeerAdvocate/RateBeer and caches
  verified results locally. No API keys required — data is pulled from
  public web pages via search.
metadata:
  type: project
  tags: [beer, craft-beer, data-harness, websearch, real-time]
  author: Peter
  version: "4.0"
---

# Beer Lens — Live Beer Data Harness

## 核心设计

本 Skill 是一个**实时数据采集层**，不依赖预建的离线数据库。
Claude 通过 WebSearch 实时拉取啤酒数据 → 提取结构化字段 → 验证 → 缓存 → 回复。

```
用户: "飞拳 IPA 多少度？评分多少？"
        │
Claude:  WebSearch("Flying Fist IPA 京A ABV Untappd rating")
        │
        搜索结果已包含: 6.5% ABV | BeerAdvocate 90 | 风格 American IPA
        │
        提取 → 验证 abv∈[0,20] rating∈[0,5] → 缓存 SQLite → 回复
```

## Trigger（触发条件）

当用户提到以下内容时，自动使用本 Skill：

- 啤酒查询："XX啤酒多少度""XX IPA评分""京A有什么酒"
- 啤酒推荐："推荐一款IPA""最好喝的精酿""有什么好的世涛"
- 风格/酒厂信息："什么是浑浊IPA""18号酒馆有哪些代表作品"
- 对比："飞拳和跳东湖哪个评分高"

## 双通道数据 Harness

```
┌─ 通道 1: 实时检索 (on-demand) ──────────────────────────┐
│                                                         │
│  用户查询 → harness.py query → cache hit?               │
│    ✅ hit  → 直接返回 (<10ms)                            │
│    ❌ miss → WebSearch → Extract → Verify → cache → 返回 │
│                                                         │
├─ 通道 2: 定时预热 (scheduled) ──────────────────────────┤
│                                                         │
│  每天 03:17 → harness.py warm-list → WebSearch × N     │
│              → Extract → Verify → cache → 报告 stats    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 通道 1: 实时检索（用户查询时触发）

**Step 1 — 先查缓存：**
```bash
cd /Volumes/SanDisk2TB/beer-lens && python3 .beer-data/harness.py query "<啤酒名>" "<酒厂名>"
```
- `hit: true` → 直接使用缓存数据，跳过后续步骤
- `hit: false` → 进入 WebSearch

**Step 2 — WebSearch 拉数据：**
```
查具体啤酒:  WebSearch("\"{啤酒名}\" \"{酒厂}\" ABV rating Untappd")
查中国精酿:  WebSearch("{中文名} {酒厂} Untappd 评分 ABV")
```

**Step 3 — Extract + Verify：**

| 字段 | 验证规则 |
|------|----------|
| abv | 0 < ABV ≤ 20 |
| rating | 0 ≤ rating ≤ 5 (Untappd) 或 0-100 (BeerAdvocate) |
| ratings_count | > 0 |
| source | 至少 2 个独立来源交叉确认 |

**Step 4 — 写入缓存：**
```bash
cd /Volumes/SanDisk2TB/beer-lens && python3 .beer-data/harness.py cache '{"name":"...","brewery":"...","style":"...","abv":...,"rating":...,"ratings_count":...,"source_platform":"...","verified":true}'
```

**Step 5 — 呈现：**
```
🍺 {啤酒名} ({中文名})
🏭 {酒厂} ({中文酒厂名})
📋 {风格} | ABV: {x}% | IBU: {y}
⭐ 评分: {rating}/5 ({ratings_count} 评分)
🔗 来源: {source_platform}
```

### 通道 2: 定时预热（每日 03:17 自动执行）

Cron 任务 `1184064b` 每天自动运行，流程：
1. `harness.py stats` — 检查 warm_list_coverage
2. `harness.py warm-list --limit 10` — 拿到待预热啤酒
3. 逐个 WebSearch → Extract → Verify → cache
4. `harness.py stale --days 30` — 检查过期缓存并刷新
5. `harness.py stats` — 报告新增数量和覆盖率

## 数据源优先级

1. **WebSearch** — 主要数据源，实时获取
2. **本地 SQLite 缓存** — 30 天内有记录的啤酒直接返回，无需搜索
3. **本地 JSON 种子数据** — `data/chinese-craft-beers.json`（298 条，作为 fallback）
4. **RateBeer Kaggle** — `.beer-data/beer.db` 14K 条（仅用于全球啤酒的补充查询）

## 本地缓存操作

```bash
# 查询缓存
cd /Volumes/SanDisk2TB/beer-lens && python3 .beer-data/lookup.py "Pliny the Elder"

# 查看缓存统计
cd /Volumes/SanDisk2TB/beer-lens && python3 .beer-data/lookup.py --stats

# 手动写入验证过的数据（用 SQLite）
cd /Volumes/SanDisk2TB/beer-lens && python3 -c "
import sqlite3
con = sqlite3.connect('.beer-data/beer.db')
con.execute('''CREATE TABLE IF NOT EXISTS beer_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, brewery TEXT, style TEXT, abv REAL,
  rating REAL, ratings_count INTEGER, ibu REAL,
  source_url TEXT, verified_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)''')
con.commit()
con.close()
"
```

## 已知限制与诚实声明

- 无法直接爬取 Untappd.com（Cloudflare 403），但 WebSearch 可从其他页面获取 Untappd 评分
- 小众/新出的啤酒搜索结果可能不完整
- 评分是快照数据（搜索时的值），不是实时更新的
- BeerAdvocate 页面可直接 WebFetch（已验证可访问）

## 相关项目

- `amsterdam-brewery-unity` — Unity 酿酒经营游戏
- `tastegraph-ai` — 小红书自动发布管道
