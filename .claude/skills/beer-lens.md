---
name: beer-lens
description: >-
  Live beer data harness v5.0. Two-tier architecture: real-time WebSearch →
  cross-verify → SQLite cache, plus daily cron cache warming. 24+ verified
  Chinese craft + international benchmark beers. No API keys required.
metadata:
  type: project
  tags: [beer, craft-beer, data-harness, websearch, real-time, chinese-craft]
  author: Peter
  version: "5.0"
  updated: "2026-07-25"
---

# Beer Lens — Live Beer Data Harness v5.0

## 核心设计

双通道实时数据 Harness。不依赖预建离线数据库，每一条数据都经过 2+ 独立来源交叉验证。

```
用户查询 → harness.py query → cache hit?
  ✅ hit  → 直接返回（<10ms，已验证数据）
  ❌ miss → WebSearch → 提取字段 → 2+源验证 → cache → 回复
```

## Trigger（触发条件）

当用户提到啤酒相关内容时自动激活：

- 啤酒查询："XX啤酒多少度""XX IPA 评分""京A有什么酒"
- 啤酒推荐："推荐一款 IPA""最好喝的精酿""有什么好的世涛"
- 风格/酒厂信息："什么是浑浊 IPA""18号酒馆有哪些代表作品"
- 对比："飞拳和跳东湖哪个评分高"

## 使用时的工作流

### Step 1 — 先查缓存

```bash
cd /Volumes/SanDisk2TB/beer-lens && python3 .beer-data/harness.py query "<啤酒名>" "<酒厂名>"
```

- `hit: true` → 数据已验证，直接呈现
- `hit: false` → 进入 Step 2

**关键**：缓存匹配是精确的（LOWER(name) = LOWER(query)），模糊匹配只在精确匹配失败后尝试。所以查询时尽量用英文原名。中文名通过 `chinese_name` 字段匹配。

### Step 2 — WebSearch 拉数据

```
查具体啤酒:  WebSearch("\"{啤酒名}\" \"{酒厂}\" ABV rating Untappd")
查中文名:    WebSearch("{中文名} {酒厂} Untappd 评分 ABV")
查中国精酿:  WebSearch("{酒厂} 精酿 Untappd 评分")
```

### Step 3 — 提取 + 验证

| 字段 | 规则 |
|------|------|
| name / brewery | 2+ 来源一致 |
| abv | 0 < ABV ≤ 20，确认单位是 % |
| rating | 0 ≤ rating ≤ 5（Untappd）或 0-100（BeerAdvocate） |
| ratings_count | 必须 > 0 |
| verified | 至少 2 个独立来源交叉确认 |

### Step 4 — 写入缓存

```bash
cd /Volumes/SanDisk2TB/beer-lens && python3 .beer-data/harness.py cache '{"name":"啤酒英文名","brewery":"酒厂英文名","chinese_name":"中文名","chinese_brewery":"酒厂中文名","style":"风格","abv":6.5,"rating":4.1,"ratings_count":1234,"source_url":"搜索URL","source_platform":"Untappd+XHS","verified":true}'
```

### Step 5 — 呈现

```
🍺 {啤酒名} ({中文名})
🏭 {酒厂} ({中文酒厂名})
📋 {风格} | ABV: {x}% | IBU: {y}
⭐ 评分: {rating}/5 ({ratings_count} 评分)
🔗 来源: {source_platform}
✅ 数据已验证 (verified)
```

## 双通道架构

```
┌─ 通道 1: 实时检索 (on-demand) ──────────────────────────┐
│  用户查询 → harness.py query → cache hit?               │
│    ✅ hit  → 直接返回 (<10ms)                            │
│    ❌ miss → WebSearch → Extract → Verify → cache → 返回 │
└─────────────────────────────────────────────────────────┘

┌─ 通道 2: 定时预热 (scheduled) ──────────────────────────┐
│  每天 03:17 → harness.py warm-list → WebSearch × N     │
│              → Extract → Verify → cache → 报告 stats    │
└─────────────────────────────────────────────────────────┘
```

## Harness 命令参考

```bash
cd /Volumes/SanDisk2TB/beer-lens

# 查询缓存
python3 .beer-data/harness.py query "Flying Fist IPA" "Jing-A"
python3 .beer-data/harness.py query "飞拳"              # 中文名也可匹配

# 查看统计
python3 .beer-data/harness.py stats
# → beer_cache total/verified, warm_list_coverage, top_accessed

# 查看待预热啤酒（不在缓存中的 warm-list 条目）
python3 .beer-data/harness.py warm-list --limit 10

# 查看过期缓存（>30 天未更新）
python3 .beer-data/harness.py stale --days 30

# 健康检查
python3 .beer-data/harness.py health

# 写入验证过的数据
python3 .beer-data/harness.py cache '<JSON>'
```

## 当前缓存状态

- **28 条已验证** (全部 verified=1)
- **warm_list_coverage**: 28/30
- **RateBeer 备份**: 14,228 条（仅作 fallback）
- **数据来源**: WebSearch → Untappd/BeerAdvocate/小红书/Brewver/JiuHuar 等

### 已缓存的中国精酿

| 啤酒 | 酒厂 | 评分 | ABV | 风格 |
|------|------|------|-----|------|
| Burning HDHC | Crazy Bear Industry | 4.27 | 8.0% | Imperial Hazy IPA |
| Hop Roulade | YE Brewing | 4.34 | 8.0% | Triple Hazy DIPA |
| Lager De Blanc | FEVER Ales | 4.15 | 6.0% | Barrel-Aged Wild Lager |
| Flying Fist IPA | 京A | 4.14 | 6.5% | West Coast IPA |
| No To Criticism | 拾捌精酿 | 3.43 | 4.5% | Session IPA |
| Captain's Pale Ale | 悠航鲜啤 | 3.39 | 4.9% | American Pale Ale |
| Mandarin Wheat | 京A | 3.61 | 4.5% | Belgian Witbier |

## 数据源优先级

1. **beer_cache** (SQLite) — 已验证的手工入库数据，最高优先级
2. **WebSearch** (实时) — cache miss 时的主要数据源
3. **untappd_cache** (SQLite) — 中国精酿种子数据（298 条，未验证）
4. **beers** (SQLite) — RateBeer Kaggle 数据集（14K 条，仅 fallback）

## 诚实声明

- 无法直接爬取 Untappd.com（Cloudflare 403），但 WebSearch 可从其他页面获取 Untappd 数据
- 小众/新出的啤酒搜索结果可能不完整
- 评分是快照数据，非实时更新
- 所有缓存数据都有 source_url 可追溯
- 数据准确性优先于数量——宁可跳过也不缓存未验证数据

## 相关项目

- `amsterdam-brewery-unity` — Unity 酿酒经营游戏
- `tastegraph-ai` — 小红书自动发布管道
