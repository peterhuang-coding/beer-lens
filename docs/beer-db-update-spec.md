# Beer Lens — 啤酒数据库更新需求

## 概述

Beer Lens 依赖本地 SQLite 数据库（`.beer-data/beer.db`）提供啤酒评分和元数据。
当前数据来源：
- **RateBeer Kaggle** — 14,228 条（静态 dump，不再更新）
- **Untappd 缓存** — 14 条（手动导入）

需要实现定期自动更新机制，保持数据库新鲜度。

## 数据库结构

### beers 表（RateBeer）
```
id, name, brewery, style, abv, rating, ratings_count,
review_aroma, review_appearance, review_palate, review_taste
```

### untappd_cache 表（Untappd）
```
id, name, brewery, style, abv, rating, ratings_count,
untappd_url, country, label_image
```

## 更新需求

### 1. Untappd 增量抓取爬虫

**目标**：从 Untappd 抓取热门啤酒数据，增量写入 `untappd_cache` 表。

**数据来源**：
- Untappd 热门榜单：`https://untappd.com/beer/top_rated`
- 按风格分类页：`https://untappd.com/beer/top_rated?type=ipa` 等
- 按国家分类页：`https://untappd.com/beer/top_rated?country=united-states` 等

**抓取字段**（每条啤酒）：
| 字段 | 来源 | 示例 |
|------|------|------|
| name | 页面标题/OG标签 | Pliny the Elder |
| brewery | 面包屑/酒厂链接 | Russian River Brewing Company |
| style | 详情页风格标签 | Imperial IPA |
| abv | 详情页 ABV 字段 | 8.0 |
| rating | 评分数字 | 4.52 |
| ratings_count | 评分人数 | 245,832 |
| untappd_url | 页面 URL | https://untappd.com/b/russian-river-brewing-company-pliny-the-elder/4499 |
| country | 酒厂国家 | United States |
| label_image | 酒标图片 URL | https://untappd.akamaized.net/... |

**抓取策略**：
- 每批次抓取 50 条
- 请求间隔：2-5 秒（避免被封）
- 优先抓取热门风格（IPA, Stout, Sour, Lager, Pilsner）
- 跳过已存在的 beer（按 name + brewery 去重）
- 写入 SQLite `untappd_cache` 表

**反爬处理**：
- User-Agent 模拟浏览器
- 支持代理配置
- 请求间隔随机化（2-5s）
- 失败重试 3 次，指数退避

### 2. RateBeer 数据刷新

**目标**：从 RateBeer 或其他公开数据集获取更新的评分数据。

**可选数据源**：
- Kaggle RateBeer 数据集（当前使用，约 3M 条评论聚合）
- BeerAdvocate 数据集
- OpenBeerDB

**更新策略**：
- 下载最新 Kaggle 数据集
- 提取评分聚合（AVG rating, COUNT）
- 对比当前数据库，只更新有变化的条目
- 新增条目追加

### 3. 定时更新调度

**目标**：自动定期执行更新。

```
调度策略：
- Untappd 热门榜：每周一次（Top 200 per style × 10 styles = 2000 条/周）
- RateBeer 数据集：每月一次（全量对比更新）
- 缓存清理：每月一次（清除过期 > 365 天的条目）
```

### 4. API 接口

**目标**：提供手动触发更新的 API。

```
POST /api/beer-db/refresh
  body: { source: "untappd" | "ratebeer" | "all", styles?: string[], limit?: number }
  response: { ok: true, added: 42, updated: 5, skipped: 128, errors: 0 }

GET /api/beer-db/stats
  response: { total_beers: 14242, untappd_cached: 14, last_update: "2026-07-01T00:00:00Z" }
```

## 实现文件

```
lib/beer-agent/beer-db/
├── pipeline.ts         # 统一入口（已有）
├── updater.ts          # 新：数据库更新调度器
├── crawlers/
│   ├── untappd.ts      # 新：Untappd 爬虫
│   └── ratebeer.ts     # 新：RateBeer 数据更新
├── data-layer.ts       # 已有：Node ↔ Python 桥
└── cache.ts            # 已有：本地缓存
```

## 优先级

| 优先级 | 任务 | 预估工作量 |
|--------|------|-----------|
| P0 | Untappd 热门榜爬虫 | 4h |
| P0 | SQLite 增量写入 | 2h |
| P1 | 定时调度 | 2h |
| P1 | API 接口 | 1h |
| P2 | RateBeer 数据刷新 | 3h |
| P2 | 反爬增强 | 2h |
