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

## 数据采集工作流

### Step 1: Search（搜索）

根据用户意图构造搜索词：

```
查具体啤酒:  WebSearch("\"{啤酒名}\" \"{酒厂}\" ABV Untappd rating")
查风格排行:  WebSearch("best {风格} beers Untappd top rated 2024 2025")
查酒厂作品:  WebSearch("\"{酒厂}\" beers list Untappd ratings")
查中国精酿:  WebSearch("中国精酿 {风格/酒厂} Untappd 评分")
```

### Step 2: Extract（提取）

从搜索结果中提取以下字段（按优先级）：

| 字段 | 提取来源 | 验证规则 |
|------|----------|----------|
| name | 搜索结果标题/snippet | 非空字符串 |
| brewery | snippet 中的 brewery/酒厂 信息 | 非空字符串 |
| style | 搜索结果中的风格描述 | 常见风格名 |
| abv | "%" 前的数字 | 0 < ABV ≤ 20 |
| rating | "评分"/"rating" 后的数字 | 0 ≤ rating ≤ 5 |
| ratings_count | "评分"/"ratings" 后的数字 | > 0 |
| ibu | "IBU" 后的数字 | 0 ≤ IBU ≤ 120 |
| source | 数据来源 URL | 必须是真实链接 |

### Step 3: Verify（验证）

**每条数据必须通过以下验证，否则标记为 unverified：**

1. **ABV 合理性**：必须在 0-20% 之间，否则标记
2. **评分范围**：Untappd 0-5，BeerAdvocate 0-100，RateBeer 0-100
3. **跨源交叉验证**：同一啤酒至少在 2 个搜索结果中确认才标记为 verified
4. **真实来源**：每条数据必须附带来源 URL，不得编造

### Step 4: Cache（缓存）

验证通过的数据写入本地 SQLite：
```
.beer-data/beer.db → table: beer_cache
  name, brewery, style, abv, rating, ratings_count, ibu,
  source_url, verified_at, created_at
```

下次查询时先查缓存，命中且未过期（< 30天）直接返回，跳过 WebSearch。

### Step 5: Present（呈现）

回复格式：
```
🍺 {啤酒名} ({中文名})
🏭 {酒厂} ({中文酒厂名})
📋 {风格} | ABV: {x}% | IBU: {y}
⭐ Untappd: {rating}/5 ({ratings_count} 评分)
🔗 来源: {source_url}
```

数据不足时如实说明，不编造。

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
