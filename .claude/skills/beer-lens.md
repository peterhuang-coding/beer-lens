---
name: beer-lens
description: >-
  Chinese craft beer database & recommendation. Query beers by name, style, or brewery.
  For menu photos and personalized taste recommendations, use the full agent pipeline.
metadata:
  type: project
  tags: [beer, craft-beer, china, recommendation, database, cli]
  author: Peter
  version: "3.0"
---

# Beer Lens — 中国精酿啤酒查询与推荐

## Trigger（触发条件）

当用户提到以下任意内容时，优先使用本 Skill：

- 啤酒推荐、精酿啤酒、中国精酿
- "推荐一款 IPA"、"有什么好喝的啤酒"、"京A 有什么"
- 查啤酒评分、啤酒风格、酒厂信息
- 酒单照片识别与推荐（需完整 Agent）
- "beer lens"、"啤酒镜头"

## Architecture（两层架构）

```
用户请求
   │
   ├── 简单查询（查酒/查风格/查酒厂）
   │     → CLI: npx beer-lens → 毫秒级，无服务器依赖
   │
   └── 复杂任务（酒单OCR/个性化推荐/口味反馈）
         → POST /api/agent → 需 Next.js 服务器运行中
```

## Tier 1: CLI 快速查询（首选，无需服务器）

所有 CLI 命令从 `data/chinese-craft-beers.json` 读取（64 款中国精酿种子数据）。

```bash
# 按名称搜索（支持中英文模糊匹配）
npx beer-lens --name "IPA"
npx beer-lens --name "飞拳"

# 按风格搜索
npx beer-lens --style "IPA"
npx beer-lens --style "Stout" --json

# 按酒厂搜索
npx beer-lens --brewery "京A"
npx beer-lens --brewery "Master Gao"

# 组合查询
npx beer-lens --style "IPA" --brewery "18号酒馆" --json

# 浏览全部数据
npx beer-lens --list-styles       # 列出所有风格
npx beer-lens --list-breweries    # 列出所有酒厂
npx beer-lens --stats             # 数据概览
```

**CLI 输出可直接管道给其他工具**: `npx beer-lens --style IPA --json | jq '.[].name'`

## Tier 2: 完整 Agent（需服务器运行）

当用户需求超出简单查询时（如酒单照片分析、个性化口味推荐、品饮记录），启动服务器后调用：

```bash
cd /Volumes/SanDisk2TB/beer-lens
npm run dev                    # → http://localhost:3000
```

### API 端点

| 端点 | 用途 |
|------|------|
| `POST /api/agent` | 对话主入口（OCR + 推荐 + 反馈） |
| `POST /api/feishu/events` | 飞书 Bot 回调 |
| `GET /api/cases` | 对话质量追踪 |
| `GET /api/traces/:id` | 单轮链路追踪 |
| `GET /api/debug-config` | Pipeline 配置 |

### 8 个意图 Handler

| 意图 | Handler | 说明 |
|------|---------|------|
| `menu_recommend` | menu-recommend.ts | 拍照酒单 → OCR → 查评分 → 推荐 |
| `follow_up_filter` | follow-up-filter.ts | 在已有菜单里过滤（"有 IPA 吗"） |
| `tasting_feedback` | tasting-feedback.ts | 品饮反馈 → 写记录 → 更新口味画像 |
| `profile_query` | profile-query.ts | 查询个人口味画像 |
| `beer_knowledge` | beer-knowledge.ts | 啤酒知识问答（纯 LLM） |
| `label_check` | label-check.ts | 酒标识别 |
| `memory_correction` | memory-correction.ts | 记忆纠正 |
| `unclear` | unclear.ts | 意图不明时追问 |

### 意图识别

意图分类器 (`intent-classifier.ts` + `intent-registry.ts`) 采用三层策略：
1. **规则优先** — 正则匹配（中文关键词、反馈格式）→ 0ms
2. **样本匹配** — few-shot keyword scoring → 0ms
3. **LLM fallback** — OpenRouter 小模型分类 → ~500ms

## 数据层

```
data/chinese-craft-beers.json  ← 64 款中国精酿种子数据（CLI 读这个）
.beer-data/beer.db             ← SQLite 14,228 款（RateBeer Kaggle + Untappd 缓存）
.beer-data/lookup.py           ← Python 查询脚本（Node 通过 child_process 调用）
```

查询优先级: Untappd 缓存 → RateBeer SQLite → Web 搜索 → "数据暂缺"

## 环境变量

```bash
# .env.local（仅 Tier 2 需要）
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_VISION_MODEL=google/gemini-2.5-flash
OPENROUTER_ANALYSIS_MODEL=openai/gpt-4o-mini
OPENROUTER_PROXY=http://127.0.0.1:7890    # 可选代理
```

## 工作流程（Claude 使用本 Skill 时）

1. **判断复杂度**：
   - 简单查询（"有什么 IPA"、"京A 评分最高的是什么"）→ CLI
   - 复杂需求（酒单照片、个性化推荐、口味分析）→ 建议启动服务器

2. **执行查询**：
   ```bash
   cd /Volumes/SanDisk2TB/beer-lens && npx beer-lens <参数>
   ```

3. **解读结果**：将 CLI 输出转化为用户友好的中文回复，包括：
   - 啤酒名称（中英文）、酒厂、风格
   - ABV、评分、评分数
   - 风格说明和适饮场景

4. **数据不足时**：当前 64 款种子数据覆盖有限，如实告知用户数据范围。未来可通过 `npm run crawl` 扩充。

## 数据扩充

```bash
npm run crawl              # 全量爬取（Untappd + 种子导入）
npm run crawl:cn           # 仅中国精酿种子
npm run crawl:untappd      # 仅 Untappd（注意：目前被 Cloudflare 403 封堵）
```

Untappd 直接爬取目前不可用（Cloudflare 反爬）。替代方案：
- 通过 WebSearch 搜集中国精酿数据
- 使用 `untappd-node` SDK（需要 API client_id/secret）
- 手动扩充 `data/chinese-craft-beers.json`

## 已知限制

1. **数据量**：仅 64 款中国精酿种子数据，覆盖率有限
2. **Untappd 爬虫**：被 Cloudflare 403 封堵，需要 API 凭证或替代方案
3. **OCR 依赖**：酒单识别需要 PaddleOCR（Python）或 OpenRouter Vision 模型
4. **无增量更新**：没有定时爬取任务，数据不会自动更新

## 相关项目

- `amsterdam-brewery-unity` — Unity 酿酒经营游戏（Beer Competition 系统）
- `tastegraph-ai` — 小红书自动发布管道
