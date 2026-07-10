# Beer Lens — 啤酒数据库爬虫需求

## 背景

Beer Lens 是一个啤酒推荐 AI Agent，依赖本地 SQLite 数据库提供啤酒评分数据。数据库文件在 `.beer-data/beer.db`，包含两张表：

```
beers (14,228条)  — RateBeer Kaggle 数据集，静态 dump
untappd_cache (14条) — Untappd 手动缓存
```

需要实现两个爬虫来定期更新数据。

## 爬虫 1: Untappd 热门啤酒抓取

### 数据来源
从 Untappd 网站抓取热门啤酒列表：
- `https://untappd.com/beer/top_rated` — 全站最高评分
- `https://untappd.com/beer/top_rated?type=ipa` — 按风格筛选
- `https://untappd.com/beer/top_rated?country=united-states` — 按国家筛选

### 抓取字段（每条啤酒）

| 字段 | HTML 位置 | 示例 |
|------|-----------|------|
| name | `.beer-details .name` 或页面标题 | Pliny the Elder |
| brewery | `.beer-details .brewery` 或面包屑 | Russian River Brewing Co. |
| style | 详情页风格标签 | Imperial IPA |
| abv | 详情页 ABV 字段（数字） | 8.0 |
| rating | `.rating .num`（保留两位小数） | 4.52 |
| ratings_count | `.rating .count`（去掉逗号） | 245832 |
| untappd_url | `a.track-click` 的 href | /b/.../4499 |
| country | 酒厂页面/面包屑国家名 | United States |
| label_image | `.beer-label img` 的 src | https://untappd.akamaized... |

### 爬取策略

1. **分页抓取**：每页约 25 条，抓取前 N 页（默认 10 页 = 250 条）
2. **请求间隔**：2-5 秒随机延迟，避免被封
3. **失败重试**：3 次，等待时间翻倍（2s → 4s → 8s）
4. **优先风格**：IPA, Hazy IPA, Stout, Sour, Lager, Pilsner, Pale Ale, Wheat, Porter, Belgian
5. **去重**：name + brewery 组合如果已在 untappd_cache 表里，跳过
6. **User-Agent**：模拟 Chrome macOS 最新版

### 反爬处理
- 使用真实浏览器 User-Agent
- 支持 HTTP/HTTPS 代理配置
- 随机化请求间隔
- 遇到 429 暂停 60 秒后重试
- 遇到验证码/Cloudflare → 记录日志，跳过当前页

### 输出格式

函数签名在 `lib/beer-agent/beer-db/crawlers/untappd.ts` 中：
```typescript
export async function crawlUntappd(options: {
  styles?: string[];      // 要抓取的风格列表
  countries?: string[];   // 要抓取的国家列表
  limit?: number;         // 最大抓取条数（默认 250）
  proxy?: string;         // HTTP 代理地址
}): Promise<{
  beers: Array<{
    name: string;
    brewery: string;
    style: string;
    abv: number;
    rating: number;
    ratings_count: number;
    untappd_url: string;
    country: string;
    label_image: string;
  }>;
  totalPages: number;
  pagesCrawled: number;
  errors: string[];
}>
```

### 写入 SQLite

抓取结果由 `lib/beer-agent/beer-db/updater.ts` 写入数据库。你需要确保返回的 `beers` 数组格式正确即可，写入逻辑已实现。

**upsert 逻辑**（updater 负责）：
- name + brewery 匹配到已有条目 → 更新 rating, ratings_count
- 未匹配到 → 新增条目
- 写入 `untappd_cache` 表

## 爬虫 2: RateBeer/BeerAdvocate 数据集更新

### 数据来源（任选其一）
1. Kaggle RateBeer: `https://www.kaggle.com/datasets/nicolashug/dataset-ratebeer`（1.58M 评论聚合）
2. BeerAdvocate: `https://www.kaggle.com/datasets/thedevastator/beer-ratings-from-beer-advocate`
3. OpenBeerDB: `https://openbeerdb.com/`

### 更新流程

1. 下载最新 CSV/ZIP
2. 解析提取：name, brewery, style, abv, avg_rating, review_count
3. 与当前 `beers` 表对比（按 name + brewery 匹配）
4. 只更新有变化的条目：
   - rating 变化 > 0.05，或
   - ratings_count 变化 > 10%
5. 新增条目追加
6. 记录更新日志到 `data/beer-db-update.json`

### 输出格式

函数签名在 `lib/beer-agent/beer-db/crawlers/ratebeer.ts` 中：
```typescript
export async function updateRateBeer(options: {
  sourceUrl?: string;     // CSV/ZIP 下载地址
  styles?: string[];      // 只更新特定风格
  minRating?: number;     // 最低评分阈值
  minRatingsCount?: number; // 最低评价数阈值
}): Promise<{
  source: string;
  totalInSource: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}>
```

## 调度策略

updater.ts 已实现定时调度框架：
- Untappd：每周一凌晨 3 点
- RateBeer：每月 1 号凌晨 4 点

## 文件位置

```
lib/beer-agent/beer-db/
├── crawlers/
│   ├── untappd.ts    ← 你实现这个（目前是桩代码）
│   └── ratebeer.ts   ← 你实现这个（目前是桩代码）
├── updater.ts        ← 调度器 + SQLite 写入（已实现）
├── data-layer.ts     ← Node ↔ Python SQLite 桥（已实现）
└── pipeline.ts       ← 统一入口（已实现）

docs/
└── beer-db-update-spec.md ← 完整需求文档

.beer-data/
├── beer.db           ← SQLite 数据库
└── lookup.py         ← Python 查询脚本（已实现）
```

## 验证方式

实现后运行：
```bash
# 测试 Untappd 抓取（只抓 IPA，限 10 条）
curl -X POST http://localhost:3001/api/beer-db/refresh \
  -H "Content-Type: application/json" \
  -d '{"source":"untappd","styles":["ipa"],"limit":10}'

# 查看数据库统计
curl http://localhost:3001/api/beer-db/stats
```

## 注意事项

1. 只替换桩代码的函数体，不要改函数签名
2. 使用 TypeScript，不要引入重量级依赖（用 fetch + 正则/cheerio 即可）
3. 做好错误处理，单个页面失败不影响整体
4. 日志用 `console.log`，前缀 `[crawler:untappd]` 或 `[crawler:ratebeer]`
